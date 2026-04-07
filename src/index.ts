/**
 * Relay Cloudflare Worker
 * =======================
 * Sits between AI agents and your origin server.
 *
 * Request flow:
 *   1. Check if SOM is explicitly requested via content negotiation:
 *      - Accept: application/som+json header
 *      - ?format=som query param
 *   2. Detect if request is from a known AI agent (UA-based)
 *   3. If neither agent nor explicit SOM request (human):
 *      - Pass through to origin
 *      - Add Link header for passive SOM discovery
 *   4. If agent or explicit SOM request: check publisher config
 *      - blocked      → return 403 + license JSON
 *      - som_enabled  → serve SOM (fetch origin, transform, cache in KV)
 *      - html fallback → pass through + Link header
 *   5. Log analytics event async (never blocks response)
 *
 * SOM discovery headers added to ALL HTML responses:
 *   Link: <url?format=som>; rel="semantic-representation"; type="application/som+json"
 *
 * Environment variables (set via wrangler.toml + wrangler secret):
 *   RELAY_API_URL        — https://relay-backend-7dip.onrender.com
 *   RELAY_API_KEY        — rly_... publisher API key
 *   SOM_CACHE_TTL_SEC    — SOM KV cache TTL in seconds (default: 300)
 *   CONFIG_CACHE_TTL_SEC — publisher config re-fetch interval (default: 60)
 */

import { detectAgent }                        from "./detector";
import { generateSOM, SOMDocument }           from "./som";
import { sendEvents, RelayEvent }             from "./analytics";

export type DiscoveryMethod = "agent-detected" | "accept-header" | "query-param";

/**
 * Returns the discovery method if SOM should be served, null otherwise.
 * Priority: explicit query param > explicit Accept header > agent detection.
 */
function getSOMDiscoveryMethod(request: Request, isAgent: boolean): DiscoveryMethod | null {
  const url    = new URL(request.url);
  const accept = request.headers.get("Accept") || "";
  if (url.searchParams.get("format") === "som") return "query-param";
  if (accept.includes("application/som+json"))   return "accept-header";
  if (isAgent)                                   return "agent-detected";
  return null;
}

/**
 * Adds the Link: rel="semantic-representation" header to a response.
 * Enables passive SOM discovery by any HTTP client.
 */
function withDiscoveryHeader(response: Response, requestUrl: string): Response {
  const u      = new URL(requestUrl);
  const somUrl = `${u.origin}${u.pathname}?format=som`;
  const headers = new Headers(response.headers);
  headers.set("Link", `<${somUrl}>; rel="semantic-representation"; type="application/som+json"`);
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Env interface ─────────────────────────────────────────────────────────────
export interface Env {
  SOM_CACHE:            KVNamespace;
  RELAY_API_URL:        string;
  RELAY_API_KEY:        string;
  SOM_CACHE_TTL_SEC:    string;
  CONFIG_CACHE_TTL_SEC: string;
}

// ── In-memory publisher config cache ─────────────────────────────────────────
interface PublisherConfig {
  publisher_id:   string;
  domain:         string;
  som_enabled:    boolean;
  license_policy: "free" | "attribution-required" | "contact" | "blocked";
  license_url:    string | null;
  plan:           string;
  fetched_at:     number; // ms epoch
}

let cachedConfig: PublisherConfig | null = null;

async function getPublisherConfig(env: Env): Promise<PublisherConfig> {
  const ttlMs = parseInt(env.CONFIG_CACHE_TTL_SEC || "60") * 1000;
  const now = Date.now();

  if (cachedConfig && now - cachedConfig.fetched_at < ttlMs) {
    return cachedConfig;
  }

  const res = await fetch(`${env.RELAY_API_URL}/publishers/me/worker-config`, {
    headers: { "X-Relay-Key": env.RELAY_API_KEY },
  });

  if (!res.ok) {
    // If we have a stale config, use it rather than failing
    if (cachedConfig) return cachedConfig;
    throw new Error(`Failed to fetch publisher config: ${res.status}`);
  }

  const data = await res.json<PublisherConfig>();
  cachedConfig = { ...data, fetched_at: now };
  return cachedConfig;
}

// ── SOM cache helpers ─────────────────────────────────────────────────────────
function somCacheKey(url: string): string {
  return `som:${url}`;
}

async function getCachedSOM(env: Env, url: string): Promise<SOMDocument | null> {
  const raw = await env.SOM_CACHE.get(somCacheKey(url));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SOMDocument;
  } catch {
    return null;
  }
}

async function cacheSOM(env: Env, url: string, som: SOMDocument): Promise<void> {
  const ttl = parseInt(env.SOM_CACHE_TTL_SEC || "300");
  await env.SOM_CACHE.put(somCacheKey(url), JSON.stringify(som), { expirationTtl: ttl });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startMs = Date.now();
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Only handle GET/HEAD — pass everything else through
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fetch(request);
    }

    // ── Detect agent + content negotiation ──────────────────────────────────
    const detection       = detectAgent(request);
    const discoveryMethod = getSOMDiscoveryMethod(request, detection.isAgent);

    if (!discoveryMethod) {
      // Human traffic — pass through, add Link header for passive discovery
      const originRes = await fetch(request);
      const ct = originRes.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        return withDiscoveryHeader(originRes, request.url);
      }
      return originRes;
    }

    // ── SOM requested (agent or explicit) — get publisher config ────────────
    let config: PublisherConfig;
    try {
      config = await getPublisherConfig(env);
    } catch {
      // Config fetch failed — fail open (pass through + discovery header)
      const originRes = await fetch(request);
      return withDiscoveryHeader(originRes, request.url);
    }

    const latencyMs = Date.now() - startMs;
    const country   = request.cf?.country as string | undefined;
    const pageUrl   = request.url;
    const pagePath  = url.pathname;

    // ── Blocked policy ────────────────────────────────────────────────────────
    if (config.license_policy === "blocked") {
      const event: RelayEvent = {
        request_id:    requestId,
        agent_name:    detection.agent.name,
        agent_tier:    detection.agent.tier,
        agent_ua:      detection.rawUa,
        page_url:      pageUrl,
        page_path:     pagePath,
        bytes_served:  0,
        bytes_saved:   0,
        format_served: "blocked",
        latency_ms:    latencyMs,
        country,
        timestamp:     new Date().toISOString(),
      };
      ctx.waitUntil(sendEvents([event], env.RELAY_API_URL, env.RELAY_API_KEY));

      return new Response(
        JSON.stringify({
          error:       "Access denied by publisher policy",
          license:     config.license_policy,
          license_url: config.license_url || null,
          publisher:   config.publisher_id,
        }),
        {
          status: 403,
          headers: {
            "Content-Type":     "application/json",
            "X-Relay-Blocked":  "true",
            "X-Relay-License":  config.license_policy,
          },
        }
      );
    }

    // ── SOM serving ───────────────────────────────────────────────────────────
    if (config.som_enabled) {
      // 1. Check KV cache
      let som = await getCachedSOM(env, pageUrl);
      let originalBytes = 0;

      if (!som) {
        // 2. Fetch from origin
        const originRes = await fetch(request.url, {
          headers: { "User-Agent": "relay-worker/1.0 (origin-fetch)" },
        });

        const contentType = originRes.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          // Non-HTML (images, JSON APIs, etc.) — pass through
          return originRes;
        }

        const html = await originRes.text();
        originalBytes = new TextEncoder().encode(html).length;

        // 3. Generate SOM
        som = await generateSOM(html, {
          publisherId:    config.publisher_id,
          publisherName:  config.domain,
          licensePolicy:  config.license_policy,
          licenseUrl:     config.license_url || "",
          agentName:      detection.agent.name,
          requestId,
          requestUrl:     pageUrl,
          originalBytes,
          discoveryMethod,
        });

        // 4. Cache it
        ctx.waitUntil(cacheSOM(env, pageUrl, som));
      }

      const somJson       = JSON.stringify(som, null, 2);
      const somBytes      = new TextEncoder().encode(somJson).length;
      const savedBytes    = Math.max(0, originalBytes - somBytes);

      const event: RelayEvent = {
        request_id:    requestId,
        agent_name:    detection.agent.name,
        agent_tier:    detection.agent.tier,
        agent_ua:      detection.rawUa,
        page_url:      pageUrl,
        page_path:     pagePath,
        word_count:    som.content.word_count,
        bytes_served:  somBytes,
        bytes_saved:   savedBytes,
        format_served: "som",
        latency_ms:    Date.now() - startMs,
        country,
        timestamp:     new Date().toISOString(),
      };
      ctx.waitUntil(sendEvents([event], env.RELAY_API_URL, env.RELAY_API_KEY));

      return new Response(somJson, {
        status: 200,
        headers: {
          "Content-Type":          "application/som+json; charset=utf-8",
          "X-Relay-Served":        "true",
          "X-Relay-Format":        "SOM/1.0",
          "X-Relay-Publisher":     config.publisher_id,
          "X-Relay-License":       config.license_policy,
          "X-Relay-Request-Id":    requestId,
          "X-Relay-Discovery":     discoveryMethod,
          "Cache-Control":         "no-store",
          "Vary":                  "Accept",
        },
      });
    }

    // ── HTML pass-through (SOM disabled or non-HTML) ─────────────────────────
    const originRes    = await fetch(request);
    const cloned       = originRes.clone();
    const html         = await cloned.text();
    const bytesServed  = new TextEncoder().encode(html).length;

    const event: RelayEvent = {
      request_id:       requestId,
      agent_name:       detection.agent.name,
      agent_tier:       detection.agent.tier,
      agent_ua:         detection.rawUa,
      page_url:         pageUrl,
      page_path:        pagePath,
      bytes_served:     bytesServed,
      bytes_saved:      0,
      format_served:    "html",
      discovery_method: discoveryMethod,
      latency_ms:       Date.now() - startMs,
      country,
      timestamp:        new Date().toISOString(),
    };
    ctx.waitUntil(sendEvents([event], env.RELAY_API_URL, env.RELAY_API_KEY));

    // Add discovery Link header so agents can learn about SOM next time
    const ct = originRes.headers.get("content-type") || "";
    if (ct.includes("text/html")) {
      return withDiscoveryHeader(originRes, request.url);
    }
    return originRes;
  },
};
