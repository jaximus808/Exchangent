import { randomUUID } from "node:crypto";

/** Outbox event kinds (doc/negotiation-contract.md, "Worker scope"). */
export type EventKind = "session.opened" | "offer.created" | "counter.created" | "session.declined";

/**
 * Outbox payload. Only IDs, kinds and public totals; never budgets or floors.
 *   session.opened   { session_id, request_id }
 *   offer.created    { session_id, request_id, offer_id, total_cents, note }
 *   counter.created  { session_id, counter_id, total_cents, note }
 *   session.declined { session_id }
 */
export interface EventPayload {
  session_id: string;
  request_id?: string;
  offer_id?: string;
  counter_id?: string;
  total_cents?: number;
  note?: string;
  seller_id?: string;
  [key: string]: unknown;
}

export interface EventRoute {
  to_role: "seller" | "buyer";
  seller_id?: string;
  buyer_id?: string;
  request_id?: string;
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
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

/** Worker-scope client for the backend (`/api/v1/worker/...`). Envelope: { data } | { error }. */
export class WorkerApi {
  base: string;
  token: string;
  fetch: typeof fetch;

  constructor({ backendUrl, token, fetchImpl = fetch }: WorkerApiOptions) {
    this.base = `${backendUrl}/api/v1`;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #request(method: "GET" | "POST", pathname: string, body?: unknown, { idempotencyKey }: { idempotencyKey?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey || randomUUID();
    const res = await this.fetch(`${this.base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
    const data = await this.#request("GET", `/worker/events?limit=${limit}`);
    // Rows follow the backend contract (WorkerEvent); they are not validated field by field.
    if (Array.isArray(data)) return data as WorkerEvent[];
    if (isRecord(data) && Array.isArray(data.events)) return data.events as WorkerEvent[];
    return [];
  }

  async ack(eventId: string): Promise<unknown> {
    return this.#request("POST", `/worker/events/${encodeURIComponent(eventId)}/ack`, {}, { idempotencyKey: `ack-${eventId}` });
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
