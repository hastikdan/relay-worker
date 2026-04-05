# Relay Worker

Cloudflare Worker that sits between AI agents and your origin server. Part of the [Relay](https://hastikdan.github.io/relay/) platform.

## What it does

For every inbound request:
1. **Detects** whether it's from an AI agent (20 known patterns + behavioral scoring)
2. **Checks** your publisher license policy (free / attribution-required / contact / blocked)
3. **Serves** a compact SOM (Structured Object Model) JSON instead of raw HTML — ~94% smaller
4. **Logs** an analytics event asynchronously (never delays the response)

Human traffic passes through to your origin unchanged.

## Quick setup

```bash
npx relay-init@latest
```

Requires Node.js 18+ and a [Cloudflare account](https://cloudflare.com). Takes ~5 minutes.

## Manual setup

```bash
git clone https://github.com/hastikdan/relay-worker
cd relay-worker
npm install

# Set your Relay API key (from https://hastikdan.github.io/relay/app/ → Setup tab)
wrangler secret put RELAY_API_KEY

# Create KV namespace for SOM cache
wrangler kv:namespace create SOM_CACHE
# Copy the returned id into wrangler.toml → kv_namespaces[0].id

# Deploy
wrangler deploy
```

Then add a Cloudflare Worker route: `yourdomain.com/*` → `relay-worker`.

## SOM format

AI agents receive a structured JSON response instead of raw HTML:

```json
{
  "relay_version": "1.0",
  "url": "https://example.com/article/title",
  "publisher": { "name": "...", "license": "attribution-required" },
  "content": {
    "title": "...",
    "body": "...",
    "author": "...",
    "word_count": 1247
  },
  "relay": { "agent_name": "anthropic-claude", "cost_saved_bytes": 172000 }
}
```

## Agent detection

Known agents (UA pattern matching, confidence 0.99):
OpenAI GPTBot, ChatGPT-User, Anthropic ClaudeBot, Claude-User, Google-Extended, Googlebot, Gemini, Meta FacebookBot, Perplexity, Apple, Cohere, Common Crawl, ByteDance, You.com, Diffbot, Amazon, Bing, and more.

Unknown agents detected via behavioral scoring (no referer, no cookies, wildcard Accept header).

## Local development

```bash
npm install
wrangler dev
```

Set env vars in `.dev.vars`:
```
RELAY_API_KEY=rly_your_key_here
RELAY_API_URL=http://localhost:8000
```

## Environment variables

| Variable | Description |
|---|---|
| `RELAY_API_KEY` | Your publisher API key (`rly_...`) — set as a secret |
| `RELAY_API_URL` | Relay backend URL (default: `https://relay-backend.onrender.com`) |
| `SOM_CACHE_TTL_SEC` | SOM cache TTL in seconds (default: 300) |
| `CONFIG_CACHE_TTL_SEC` | Publisher config re-fetch interval (default: 60) |
