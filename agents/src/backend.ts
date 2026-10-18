import { randomUUID } from "node:crypto";
import type { DeliveryReceipt } from "./transport/index.ts";

/** Negotiation event kinds (doc/negotiation-contract.md, "Worker scope"): each one is a brain turn. */
export type NegotiationKind = "session.opened" | "offer.created" | "counter.created" | "session.declined";

/**
 * Outbox event kinds. `order.confirmed` (doc/signup-contract.md; to the seller, and to the buyer since
 * doc/hardening-contract.md) and `session.closed` (to the seller) are notices, never turns.
 */
export type EventKind = NegotiationKind | "order.confirmed" | "session.closed" | CaseEventKind;

/**
 * After-sale events (doc/resolution-contract.md). case.opened / case.offer are turns for the side whose turn it
 * is; the rest are notices (an email to a person, never a turn).
 */
export type CaseEventKind =
  | "case.opened"
  | "case.offer"
  | "case.resolved"
  | "case.escalated"
  | "order.shipped"
  | "order.delivered"
  | "refund.succeeded"
  | "dispute.created"
  | "dispute.decided";

/** GET /worker/buyer-requests?email= (email-your-agent): the sender's delegated, open requests. No budgets. */
export interface BuyerRequestStatus {
  request_id: string;
  title?: string | null;
  status?: string;
  best_offer?: { seller_name: string; total_cents: number } | null;
  sessions_open?: number;
  watch_path?: string;
}

/**
 * Outbox payload. Only IDs, kinds and public totals; never budgets or floors.
 *   session.opened   { session_id, request_id }
 *   offer.created    { session_id, request_id, offer_id, total_cents, note }
 *   counter.created  { session_id, counter_id, total_cents, note }
 *   session.declined { session_id }
 *   order.confirmed  { order_id, reservation_id, request_id, seller_id, total_cents, currency, title }
 */
export interface EventPayload {
  /** Every negotiation event carries it; order.confirmed does not. */
  session_id?: string;
  request_id?: string;
  offer_id?: string;
  counter_id?: string;
  total_cents?: number;
  note?: string;
  seller_id?: string;
  order_id?: string;
  reservation_id?: string;
  currency?: string;
  title?: string;
  [key: string]: unknown;
}

export interface EventRoute {
  to_role: "seller" | "buyer";
  seller_id?: string;
  buyer_id?: string;
  request_id?: string;
  /** The request's delegate_negotiation: the buyer lets the buyer agent negotiate. */
  delegated?: boolean;
  /** The seller's delegate_negotiation: the owner lets the seller agent negotiate (false: they negotiate in chat). */
  seller_delegated?: boolean;
  /** Preferred Inkbox handle when the recipient's identity is created. */
  agent_handle?: string;
}

/** One undelivered outbox row from GET /api/v1/worker/events. */
export interface WorkerEvent {
  id: string;
  kind: EventKind;
  created_at: string;
  payload: EventPayload;
  route?: EventRoute;
}

/** POST /worker/sellers/:id/token: a seller-scope token for the platform seller agent (doc/signup-contract.md). */
export interface SellerAgentToken {
  token: string;
  seller_id: string;
  name: string;
  expires_at: string;
  agent_handle?: string | null;
}

export class BackendError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(`backend ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export interface WorkerApiOptions {
  backendUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Abort any backend call after this long (default 15 s), so one hung request cannot freeze the dispatcher. */
  timeoutMs?: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

/** Worker-scope client for the backend (`/api/v1/worker/...`). Envelope: { data } | { error }. */
export class WorkerApi {
  base: string;
  token: string;
  fetch: typeof fetch;
  timeoutMs: number;

  constructor({ backendUrl, token, fetchImpl = fetch, timeoutMs = 15000 }: WorkerApiOptions) {
    this.base = `${backendUrl}/api/v1`;
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async #request(method: "GET" | "POST", pathname: string, body?: unknown, { idempotencyKey }: { idempotencyKey?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey || randomUUID();
    const res = await this.fetch(`${this.base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    const envelope = isRecord(json) ? json : null;
    if (!res.ok || envelope?.error) {
      const err = isRecord(envelope?.error) ? envelope.error : {};
      throw new BackendError(res.status, String(err.code || "http_error"), String(err.message || text.slice(0, 200)));
    }
    // `in` on a non-object JSON body throws a TypeError, exactly as before.
    return json && "data" in (json as object) ? (json as { data: unknown }).data : json;
  }

  /** Undelivered outbox rows, oldest first. Accepts `data: [...]` or `data: { events: [...] }`. */
  async events(limit = 20): Promise<WorkerEvent[]> {
    const data = await this.#request("GET", `/worker/events?limit=${limit}&v=2&include=resolution`);
    // Rows follow the backend contract (WorkerEvent); they are not validated field by field.
    if (Array.isArray(data)) return data as WorkerEvent[];
    if (isRecord(data) && Array.isArray(data.events)) return data.events as WorkerEvent[];
    return [];
  }

  /** Ack one event. A delivery receipt (doc/conversation-contract.md) is stored for the conversation views. */
  async ack(eventId: string, delivery?: DeliveryReceipt): Promise<unknown> {
    return this.#request("POST", `/worker/events/${encodeURIComponent(eventId)}/ack`, delivery ? { delivery } : {}, { idempotencyKey: `ack-${eventId}` });
  }

  /** Mint a seller token for a business whose owner delegated negotiation (403 not_delegated otherwise). */
  async mintSellerToken(sellerId: string, hours?: number): Promise<SellerAgentToken> {
    const data = await this.#request("POST", `/worker/sellers/${encodeURIComponent(sellerId)}/token`, hours ? { hours } : {});
    // Follows the backend contract (SellerAgentToken); token presence is checked by the caller.
    return data as SellerAgentToken;
  }

  /**
   * POST /worker/sweep: the backend releases stale holds and expires requests past their deadline
   * (doc/hardening-contract.md). Returns its counts, or null when this backend has no sweep route yet (404).
   */
  async sweep(): Promise<unknown> {
    try {
      const counts = await this.#request("POST", "/worker/sweep", {});
      // Closes delivered orders whose dispute window ended (resolution backend). Optional on older backends.
      await this.#request("POST", "/worker/resolution-sweep", {}).catch((err: unknown) => {
        if (!(err instanceof BackendError && err.status === 404)) throw err;
      });
      return counts;
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) return null;
      throw err;
    }
  }

  /** The business owner's email (worker scope), for owners who negotiate in chat. null on an older backend. */
  async sellerOwner(sellerId: string): Promise<{ seller_id: string; name: string; owner_email: string | null } | null> {
    try {
      return (await this.#request("GET", `/worker/sellers/${encodeURIComponent(sellerId)}/owner`)) as { seller_id: string; name: string; owner_email: string | null };
    } catch (err) {
      if (err instanceof BackendError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * The delegated, non-closed requests of the buyer with exactly this email (email-your-agent). Throws
   * BackendError 404 not_found when this backend has no such route yet; the caller then stays quiet.
   */
  async buyerRequestsByEmail(email: string): Promise<BuyerRequestStatus[]> {
    const data = await this.#request("GET", `/worker/buyer-requests?email=${encodeURIComponent(email)}`);
    if (Array.isArray(data)) return data as BuyerRequestStatus[];
    if (isRecord(data) && Array.isArray(data.requests)) return data.requests as BuyerRequestStatus[];
    return [];
  }

  async registerSellerAgent(sellerId: string, agentHandle: string): Promise<unknown> {
    return this.#request(
      "POST",
      `/worker/sellers/${encodeURIComponent(sellerId)}/agent`,
      { agent_handle: agentHandle },
      { idempotencyKey: `agent-${sellerId}-${agentHandle}` },
    );
  }
}
