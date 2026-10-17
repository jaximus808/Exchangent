import { randomUUID } from "node:crypto";

export class BackendError extends Error {
  constructor(status, code, message) {
    super(`backend ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** Worker-scope client for the backend (`/api/v1/worker/...`). Envelope: { data } | { error }. */
export class WorkerApi {
  constructor({ backendUrl, token, fetchImpl = fetch }) {
    this.base = `${backendUrl}/api/v1`;
    this.token = token;
    this.fetch = fetchImpl;
  }

  async #request(method, pathname, body, { idempotencyKey } = {}) {
    const headers = { authorization: `Bearer ${this.token}`, accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["idempotency-key"] = idempotencyKey || randomUUID();
    const res = await this.fetch(`${this.base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok || json?.error) {
      const err = json?.error || {};
      throw new BackendError(res.status, err.code || "http_error", err.message || text.slice(0, 200));
    }
    return json && "data" in json ? json.data : json;
  }

  /** Undelivered outbox rows, oldest first. Accepts `data: [...]` or `data: { events: [...] }`. */
  async events(limit = 20) {
    const data = await this.#request("GET", `/worker/events?limit=${limit}`);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.events)) return data.events;
    return [];
  }

  async ack(eventId) {
    return this.#request("POST", `/worker/events/${encodeURIComponent(eventId)}/ack`, {}, { idempotencyKey: `ack-${eventId}` });
  }

  async registerSellerAgent(sellerId, agentHandle) {
    return this.#request(
      "POST",
      `/worker/sellers/${encodeURIComponent(sellerId)}/agent`,
      { agent_handle: agentHandle },
      { idempotencyKey: `agent-${sellerId}-${agentHandle}` },
    );
  }
}
