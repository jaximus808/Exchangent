import { logger, short } from "./log.ts";
import type { Agent, AgentRegistry } from "./agents.ts";
import type { WorkerApi, WorkerEvent } from "./backend.ts";
import type { Transport } from "./transport/index.ts";

const log = logger("dispatcher");

/** Where one event goes: `from` is the counterparty agent (null if unknown), `to` the recipient. */
export type Route = { from: Agent | null; to: Agent; error?: undefined } | { error: string; from?: undefined; to?: undefined };

export interface DispatcherOptions {
  api: Pick<WorkerApi, "events" | "ack">;
  transport: Transport;
  registry: AgentRegistry;
  pollMs?: number;
  limit?: number;
}

/**
 * Polls GET /api/v1/worker/events, routes each outbox event to its target agent, delivers it through the
 * transport and only then acks it (at-least-once; receivers dedupe by event id).
 */
export class Dispatcher {
  api: Pick<WorkerApi, "events" | "ack">;
  transport: Transport;
  registry: AgentRegistry;
  pollMs: number;
  limit: number;
  sessionSeller: Map<string, string>;
  lastError: Map<string, string>;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;

  constructor({ api, transport, registry, pollMs = 1000, limit = 20 }: DispatcherOptions) {
    this.api = api;
    this.transport = transport;
    this.registry = registry;
    this.pollMs = pollMs;
    this.limit = limit;
    this.sessionSeller = new Map(); // session_id -> seller_id, learned from seller-bound events
    this.lastError = new Map(); // event id -> last error message (log each distinct failure once)
    this.timer = null;
    this.stopped = true;
  }

  /** Resolve { from, to } agents for an event. The sender is always the counterparty agent. */
  route(event: WorkerEvent): Route {
    const r: Partial<NonNullable<WorkerEvent["route"]>> = event.route || {};
    const sessionId = event.payload?.session_id;
    if (r.to_role === "seller") {
      const sellerId = r.seller_id || this.sessionSeller.get(sessionId);
      const to = sellerId ? this.registry.seller(sellerId) : null;
      if (!to) return { error: `unknown seller ${sellerId} (not in principals file)` };
      if (sessionId) this.sessionSeller.set(sessionId, sellerId!); // `to` exists, so sellerId was set
      return { from: this.registry.buyer, to };
    }
    if (r.to_role === "buyer") {
      const sellerId = r.seller_id || event.payload?.seller_id || this.sessionSeller.get(sessionId);
      if (sellerId && sessionId) this.sessionSeller.set(sessionId, sellerId);
      return { from: sellerId ? this.registry.seller(sellerId) : null, to: this.registry.buyer };
    }
    return { error: `unroutable event: route.to_role=${r.to_role}` };
  }

  async tick(): Promise<number> {
    const events = await this.api.events(this.limit);
    const blocked = new Set<string>(); // keep per-agent order: after a failure, skip that agent's later events
    let delivered = 0;
    for (const event of events) {
      const { from, to, error } = this.route(event);
      if (error !== undefined) {
        this.#fail(event, error);
        continue;
      }
      if (blocked.has(to.id)) continue;
      try {
        log.info(`deliver ${event.kind}`, {
          from: from?.id ?? "?",
          to: to.id,
          session: event.payload?.session_id,
          total_cents: event.payload?.total_cents,
          event: event.id,
        });
        await this.transport.send(from, to, event);
        await this.api.ack(event.id);
        this.lastError.delete(event.id);
        delivered++;
      } catch (err) {
        blocked.add(to.id);
        this.#fail(event, (err as Error).message);
      }
    }
    return delivered;
  }

  #fail(event: WorkerEvent, message: string): void {
    if (this.lastError.get(event.id) === message) return;
    this.lastError.set(event.id, message);
    log.error(`not delivered (will retry) ${event.kind}`, { event: short(event.id), reason: message });
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
        this.lastError.delete("__poll");
      } catch (err) {
        const message = (err as Error).message;
        if (this.lastError.get("__poll") !== message) log.error("poll failed", { reason: message });
        this.lastError.set("__poll", message);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer ?? undefined);
  }
}
