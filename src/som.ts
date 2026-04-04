/**
 * SOM (Structured Object Model) Generator
 *
 * Transforms raw HTML responses into compact, semantically structured JSON
 * for AI agent consumption. Average reduction: 94–96% of original byte size.
 *
 * Priority order for content extraction:
 *   1. JSON-LD structured data (most reliable)
 *   2. Open Graph / meta tags
 *   3. HTML semantic elements (article, main, h1)
 */

export interface SOMContent {
  title: string;
  description: string;
  author: string;
  published_at: string;
  updated_at: string;
  language: string;
  body: string;
  word_count: number;
  reading_time_minutes: number;
}

export interface SOMMetadata {
  topics: string[];
  paywall: boolean;
  canonical: string;
}

export interface SOMPublisher {
  name: string;
  id: string;
  license: string;
  license_url: string;
}

export interface SOMRelay {
  served_at: string;
  agent_name: string;
  request_id: string;
  cost_saved_bytes: number;
  format_version: string;
}

export interface SOMDocument {
  relay_version: string;
  url: string;
  canonical: string;
  publisher: SOMPublisher;
  content: SOMContent;
  metadata: SOMMetadata;
  relay: SOMRelay;
}

// ── HTML parsing helpers (no DOM available in Workers — use regex) ────────────

function extractMeta(html: string, name: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, "i"),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return "";
}

function extractOG(html: string, property: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']og:${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${property}["']`, "i"),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return "";
}

function extractJsonLd(html: string): Record<string, unknown> {
  const m = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return {};
  try {
    const parsed = JSON.parse(m[1]);
    // Handle @graph arrays
    if (Array.isArray(parsed["@graph"])) {
      const article = parsed["@graph"].find(
        (n: Record<string, unknown>) =>
          typeof n["@type"] === "string" &&
          ["Article", "NewsArticle", "BlogPosting", "WebPage"].includes(n["@type"])
      );
      return article || parsed["@graph"][0] || {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function stripHtml(html: string): string {
  // Remove script/style blocks
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    // Remove remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}

function extractArticleBody(html: string): string {
  // Try article tag first, then main, then body
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return stripHtml(articleMatch[1]);

  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return stripHtml(mainMatch[1]);

  return stripHtml(html).slice(0, 10000); // fallback: full stripped body, capped
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface SOMGeneratorOptions {
  publisherId: string;
  publisherName: string;
  licensePolicy: string;
  licenseUrl: string;
  agentName: string;
  requestId: string;
  requestUrl: string;
  originalBytes: number;
}

export function generateSOM(html: string, opts: SOMGeneratorOptions): SOMDocument {
  const jsonld = extractJsonLd(html);

  const title =
    (jsonld["headline"] as string) ||
    (jsonld["name"] as string) ||
    extractOG(html, "title") ||
    extractMeta(html, "title") ||
    (html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "");

  const description =
    (jsonld["description"] as string) ||
    extractOG(html, "description") ||
    extractMeta(html, "description") ||
    "";

  const author =
    (typeof jsonld["author"] === "object" && jsonld["author"] !== null
      ? ((jsonld["author"] as Record<string, unknown>)["name"] as string)
      : (jsonld["author"] as string)) ||
    extractMeta(html, "author") ||
    extractOG(html, "article:author") ||
    "";

  const published_at =
    (jsonld["datePublished"] as string) ||
    extractMeta(html, "article:published_time") ||
    extractOG(html, "article:published_time") ||
    "";

  const updated_at =
    (jsonld["dateModified"] as string) ||
    extractMeta(html, "article:modified_time") ||
    "";

  const language =
    (html.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] ?? "en");

  const canonical =
    (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? opts.requestUrl) ||
    extractOG(html, "url") ||
    opts.requestUrl;

  const body = extractArticleBody(html).slice(0, 50000); // hard cap at 50k chars
  const wc = wordCount(body);
  const somBytes = JSON.stringify({ body }).length;
  const bytesSaved = Math.max(0, opts.originalBytes - somBytes);

  return {
    relay_version: "1.0",
    url: opts.requestUrl,
    canonical,
    publisher: {
      name:        opts.publisherName,
      id:          opts.publisherId,
      license:     opts.licensePolicy,
      license_url: opts.licenseUrl || "",
    },
    content: {
      title,
      description,
      author,
      published_at,
      updated_at,
      language,
      body,
      word_count:             wc,
      reading_time_minutes:   Math.max(1, Math.round(wc / 238)),
    },
    metadata: {
      topics:    [], // future: NLP topic extraction
      paywall:   html.includes("paywall") || html.includes("subscribe-wall"),
      canonical,
    },
    relay: {
      served_at:        new Date().toISOString(),
      agent_name:       opts.agentName,
      request_id:       opts.requestId,
      cost_saved_bytes: bytesSaved,
      format_version:   "SOM/1.0",
    },
  };
}
