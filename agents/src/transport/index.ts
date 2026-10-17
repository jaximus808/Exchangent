// Transport interface (doc/negotiation-contract.md, "Agents"):
//
//   start(agents)                    bring up receivers for every agent (tunnels, queues)
//   send(fromAgent, toAgent, event)  deliver one outbox event; resolves once the transport accepted it
//   onMessage(agent, handler)        handler(message) is called for each inbound message for that agent
//   close()
//
// A message is { id, kind, created_at, from, payload } where payload holds only IDs and public totals.
// Receivers dedupe by message id (= outbox event id). Brains never trust numbers in a message.

import type { Agent } from "../agents.ts";
import type { EventKind, WorkerEvent } from "../backend.ts";
import type { Config } from "../config.ts";
import type { InkboxTransportDeps } from "./inkbox.ts";

export const PUBLIC_PAYLOAD_KEYS = ["session_id", "request_id", "offer_id", "counter_id", "total_cents", "note"] as const;

/** The whitelisted, public part of an outbox payload. */
export type PublicPayload = {
  session_id: string;
  request_id?: string;
  offer_id?: string;
  counter_id?: string;
  total_cents?: number;
  note?: string;
};

/** What a transport hands to an agent's mailbox. `id` is the outbox event id. */
export interface TransportMessage {
  id: string;
  kind: EventKind;
  created_at: string | null;
  /** Sending agent id (the counterparty), or null if unknown. */
  from: string | null;
  payload: PublicPayload;
}

export type MessageHandler = (message: TransportMessage) => unknown;

export interface Transport {
  readonly name: string;
  start(agents: Agent[]): Promise<void>;
  send(fromAgent: Agent | null, toAgent: Agent, event: WorkerEvent): Promise<void>;
  onMessage(agent: Agent, handler: MessageHandler): void;
  close(): Promise<void>;
}

/** Defense in depth: forward only whitelisted, public payload fields. */
export function publicPayload(payload: Record<string, unknown> = {}): PublicPayload {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_PAYLOAD_KEYS) if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  // Values are copied as received; every outbox payload carries session_id (backend contract).
  return out as PublicPayload;
}

export function toMessage(fromAgent: Agent | null | undefined, event: WorkerEvent): TransportMessage {
  return {
    id: event.id,
    kind: event.kind,
    created_at: event.created_at,
    from: fromAgent?.id ?? null,
    // route.request_id is an ID (public); session.declined/counter.created payloads lack it.
    payload: publicPayload({ request_id: event.route?.request_id, ...event.payload }),
  };
}

export async function createTransport(config: Config, deps: InkboxTransportDeps): Promise<Transport> {
  if (config.transport === "inkbox") {
    const { InkboxTransport } = await import("./inkbox.ts");
    return new InkboxTransport({ ...config.inkbox, stateDir: config.stateDir, ...deps });
  }
  const { LocalTransport } = await import("./local.ts");
  return new LocalTransport();
}
