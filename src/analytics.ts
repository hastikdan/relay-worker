/**
 * Analytics event buffer + batch sender.
 *
 * Events are buffered in memory and flushed via ctx.waitUntil()
 * so they never block the response path.
 *
 * Batches are sent to the Relay backend /events/ingest endpoint.
 */

export interface RelayEvent {
  request_id:    string;
  agent_name:    string;
  agent_tier:    string;
  agent_ua?:     string;
  page_url:      string;
  page_path:     string;
  word_count?:   number;
  bytes_served:  number;
  bytes_saved:   number;
  format_served: "som" | "html" | "blocked";
  latency_ms?:   number;
  country?:      string;
  timestamp:     string;
}

export async function sendEvents(
  events: RelayEvent[],
  apiUrl: string,
  apiKey: string
): Promise<void> {
  if (events.length === 0) return;

  try {
    await fetch(`${apiUrl}/events/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Key":  apiKey,
      },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Best-effort — never throw from analytics path
  }
}
