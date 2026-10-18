// Transport interface (doc/negotiation-contract.md, "Agents"):
//
//   start(agents)                    bring up receivers for every agent (tunnels, queues)
//   send(fromAgent, toAgent, event)  deliver one outbox event; resolves with a receipt once the transport accepted it
//   onMessage(agent, handler)        handler(message) is called for each inbound message for that agent
//   close()
//
// A message is { id, kind, created_at, from, payload } where payload holds only IDs and public totals.
// Receivers dedupe by message id (= outbox event id). Brains never trust numbers in a message.

import type { Agent } from "../agents.ts";
import type { EventKind, WorkerEvent } from "../backend.ts";
import type { Config } from "../config.ts";
import type { InkboxTransportDeps } from "./inkbox.ts";
import type { EmailMessage } from "../notify.ts";

export const PUBLIC_PAYLOAD_KEYS = ["session_id", "request_id", "offer_id", "counter_id", "total_cents", "note", "case_id", "order_id"] as const;

/** The whitelisted, public part of an outbox payload. Case events (doc/resolution-contract.md) carry case_id and order_id instead of a session. */
export type PublicPayload = {
  session_id: string;
  request_id?: string;
  offer_id?: string;
  counter_id?: string;
  total_cents?: number;
  note?: string;
  case_id?: string;
  order_id?: string;
};

/** One inbound email (email-your-agent). `createdAt` is ISO; `messageId` is the RFC 5322 Message-ID for threading. */
export interface InboundEmail {
  id: string;
  messageId: string | null;
  threadId: string | null;
  from: string;
  subject: string | null;
  snippet: string | null;
  createdAt: string;
}

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

/**
 * How one outbox event was delivered (doc/conversation-contract.md). The dispatcher acks with it, so the
 * conversation views can show each hop. Inkbox: identity handles, message id = event id, the A2A context.
 * In-process: `transport: "local"` and agent slugs. Strings only (the backend stores at most 200 chars each).
 */
export interface DeliveryReceipt {
  transport: "inkbox" | "local";
  from_handle?: string;
  to_handle?: string;
  message_id: string;
  context_id?: string;
  delivered_at: string;
}

/** Receipt for an in-process delivery. No sender (a person in chat) leaves from_handle out. */
export function localReceipt(fromAgent: Agent | null, toAgent: Agent, event: WorkerEvent): DeliveryReceipt {
  return {
    transport: "local",
    ...(fromAgent ? { from_handle: fromAgent.slug } : {}),
    to_handle: toAgent.slug,
    message_id: event.id,
    delivered_at: new Date().toISOString(),
  };
}

export interface Transport {
  readonly name: string;
  start(agents: Agent[]): Promise<void>;
  send(fromAgent: Agent | null, toAgent: Agent, event: WorkerEvent): Promise<DeliveryReceipt>;
  onMessage(agent: Agent, handler: MessageHandler): void;
  /** Email a human from this agent (Inkbox: the identity's own mailbox; local: logged, not sent). */
  email(from: Agent, message: EmailMessage): Promise<void>;
  /** False when this agent has no mailbox here (Inkbox: no identity); the caller sends from another agent. */
  hasMailbox?(agent: Agent): boolean;
  /** Inbound emails to this agent's mailbox since `since`, oldest first (Inkbox only; email-your-agent). */
  inboundEmails?(agent: Agent, since: Date | null): Promise<InboundEmail[]>;
  markEmailsRead?(agent: Agent, ids: string[]): Promise<void>;
  /** Our own identities' addresses (mail from them is never answered). */
  ownEmailAddresses?(): Promise<string[]>;
  close(): Promise<void>;
}

/** Defense in depth: forward only whitelisted, public payload fields. */
export function publicPayload(payload: Record<string, unknown> = {}): PublicPayload {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_PAYLOAD_KEYS) if (payload[k] !== undefined && payload[k] !== null) out[k] = payload[k];
  // Values are copied as received; every negotiation event payload carries session_id (backend contract).
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
