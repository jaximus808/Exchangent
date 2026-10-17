// Transport interface (doc/negotiation-contract.md, "Agents"):
//
//   start(agents)                    bring up receivers for every agent (tunnels, queues)
//   send(fromAgent, toAgent, event)  deliver one outbox event; resolves once the transport accepted it
//   onMessage(agent, handler)        handler(message) is called for each inbound message for that agent
//   close()
//
// A message is { id, kind, created_at, from, payload } where payload holds only IDs and public totals.
// Receivers dedupe by message id (= outbox event id). Brains never trust numbers in a message.

export const PUBLIC_PAYLOAD_KEYS = ["session_id", "request_id", "offer_id", "counter_id", "total_cents", "note"];

/** Defense in depth: forward only whitelisted, public payload fields. */
export function publicPayload(payload = {}) {
  const out = {};
  for (const k of PUBLIC_PAYLOAD_KEYS) if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  return out;
}

export function toMessage(fromAgent, event) {
  return {
    id: event.id,
    kind: event.kind,
    created_at: event.created_at,
    from: fromAgent?.id ?? null,
    // route.request_id is an ID (public); session.declined/counter.created payloads lack it.
    payload: publicPayload({ request_id: event.route?.request_id, ...event.payload }),
  };
}

export async function createTransport(config, deps) {
  if (config.transport === "inkbox") {
    const { InkboxTransport } = await import("./inkbox.mjs");
    return new InkboxTransport({ ...config.inkbox, stateDir: config.stateDir, ...deps });
  }
  const { LocalTransport } = await import("./local.mjs");
  return new LocalTransport();
}
