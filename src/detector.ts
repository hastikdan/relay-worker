/**
 * Agent Detection Engine
 * Classifies inbound requests as 'agent' | 'human' | 'unknown'
 * with a confidence score and agent metadata.
 */

export type AgentTier = "training" | "inference" | "search" | "unknown";

export interface AgentMatch {
  name: string;
  tier: AgentTier;
  confidence: number; // 0.0 – 1.0
}

export interface DetectionResult {
  isAgent: boolean;
  agent: AgentMatch;
  rawUa: string;
}

// ── Known agent UA patterns ───────────────────────────────────────────────────
const KNOWN_AGENTS: Array<{ pattern: RegExp; name: string; tier: AgentTier }> = [
  // OpenAI
  { pattern: /GPTBot/i,           name: "openai-gptbot",    tier: "training"   },
  { pattern: /ChatGPT-User/i,     name: "openai-chatgpt",   tier: "inference"  },
  { pattern: /OAI-SearchBot/i,    name: "openai-search",    tier: "search"     },
  // Anthropic
  { pattern: /ClaudeBot/i,        name: "anthropic-claude", tier: "training"   },
  { pattern: /Claude-User/i,      name: "anthropic-claude", tier: "inference"  },
  // Google
  { pattern: /Google-Extended/i,  name: "google-extended",  tier: "training"   },
  { pattern: /Googlebot/i,        name: "google-search",    tier: "search"     },
  { pattern: /Gemini/i,           name: "google-gemini",    tier: "inference"  },
  // Meta
  { pattern: /FacebookBot/i,      name: "meta-facebook",    tier: "training"   },
  { pattern: /Meta-ExternalAgent/i, name: "meta-agent",     tier: "inference"  },
  // Perplexity
  { pattern: /PerplexityBot/i,    name: "perplexity",       tier: "inference"  },
  // Apple
  { pattern: /Applebot/i,         name: "apple",            tier: "training"   },
  // Cohere
  { pattern: /cohere-ai/i,        name: "cohere",           tier: "training"   },
  // Common Crawl (feeds many LLMs)
  { pattern: /CCBot/i,            name: "common-crawl",     tier: "training"   },
  // ByteDance
  { pattern: /Bytespider/i,       name: "bytedance",        tier: "training"   },
  // You.com
  { pattern: /YouBot/i,           name: "you-com",          tier: "inference"  },
  // Diffbot
  { pattern: /Diffbot/i,          name: "diffbot",          tier: "training"   },
  // Amazon
  { pattern: /Amazonbot/i,        name: "amazon",           tier: "training"   },
  // Microsoft Bing
  { pattern: /bingbot/i,          name: "bing-search",      tier: "search"     },
  // Generic LLM patterns
  { pattern: /llm|language.model|ai.crawler|ai.bot/i, name: "generic-ai", tier: "unknown" },
];

// ── Behavioral heuristics ─────────────────────────────────────────────────────
function behaviorScore(req: Request): number {
  let score = 0;
  const ua = req.headers.get("user-agent") || "";
  const accept = req.headers.get("accept") || "";
  const acceptLang = req.headers.get("accept-language") || "";
  const referer = req.headers.get("referer") || "";
  const cookie = req.headers.get("cookie") || "";

  // Agents rarely send text/html with quality factors
  if (!accept.includes("text/html") || accept === "*/*") score += 0.2;
  // Agents rarely send Accept-Language
  if (!acceptLang) score += 0.2;
  // Agents almost never send Referer
  if (!referer) score += 0.15;
  // Agents almost never send cookies
  if (!cookie) score += 0.1;
  // Suspiciously minimal UA
  if (ua.length < 30 && !ua.includes("Mozilla")) score += 0.2;

  return Math.min(score, 1.0);
}

// ── Main detection function ───────────────────────────────────────────────────
export function detectAgent(req: Request): DetectionResult {
  const ua = req.headers.get("user-agent") || "";

  // 1. UA pattern match (authoritative)
  for (const known of KNOWN_AGENTS) {
    if (known.pattern.test(ua)) {
      return {
        isAgent: true,
        agent: { name: known.name, tier: known.tier, confidence: 0.99 },
        rawUa: ua,
      };
    }
  }

  // 2. Behavioral scoring for unknowns
  const score = behaviorScore(req);
  if (score >= 0.55) {
    return {
      isAgent: true,
      agent: { name: "unknown", tier: "unknown", confidence: score },
      rawUa: ua,
    };
  }

  return {
    isAgent: false,
    agent: { name: "human", tier: "unknown", confidence: 1 - score },
    rawUa: ua,
  };
}
