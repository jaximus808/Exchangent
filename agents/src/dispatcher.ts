import { logger, short } from "./log.ts";
import type { Agent, AgentRegistry, SellerAgent } from "./agents.ts";
import type { WorkerApi, WorkerEvent } from "./backend.ts";
import type { Transport } from "./transport/index.ts";

const log = logger("dispatcher");

/** Where one event goes: `from` is the counterparty agent (null if unknown), `to` the recipient. */
export type Route =
  | { from: Agent | null; to: Agent; error?: undefined; skip?: undefined }
  | { error: string; from?: undefined; to?: undefined; skip?: undefined }
  | { skip: string; from?: undefined; to?: undefined; error?: undefined };

/** Handles a notice event (order.confirmed) for its seller agent. Never a brain turn, never a transport send. */
export type NoticeHandler = (to: SellerAgent, event: WorkerEvent) => Promise<void>;

/** Event kinds that are notices for an agent rather than negotiation turns. */
export const NOTICE_KINDS: ReadonlySet<string> = new Set(["order.confirmed"]);

export interface DispatcherOptions {
  api: Pick<WorkerApi, "events" | "ack">;
  transport: Transport;
  registry: AgentRegistry;
  pollMs?: number;
  limit?: number;
  /** Ack events created before this time without delivering them (SKIP_BACKLOG). */
  since?: Date | null;
  /** order.confirmed -> sale email (SaleNotifier.onOrder). Without one, notices are acked and skipped. */
  onNotice?: NoticeHandler | null;
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
  since: Date | null;
  onNotice: NoticeHandler | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;

  constructor({ api, transport, registry, pollMs = 1000, limit = 20, since = null, onNotice = null }: DispatcherOptions) {
    this.api = api;
    this.transport = transport;
    this.registry = registry;
    this.pollMs = pollMs;
    this.limit = limit;
    this.sessionSeller = new Map(); // session_id -> seller_id, learned from seller-bound events
    this.lastError = new Map(); // event id -> last error message (log each distinct failure once)
    this.since = since;
    this.onNotice = onNotice;
    this.timer = null;
    this.stopped = true;
  }

  /**
   * Resolve { from, to } agents for an event. The sender is always the counterparty agent. An order the
   * buyer agent does not negotiate (not delegated, or another buyer's when the agent holds one buyer's token)
   * has no counterparty agent: seller-bound events then have `from: null`, and buyer-bound events are
   * skipped because that person negotiates in chat and reads them over MCP. Likewise a business whose owner
   * turned agent negotiation off (route.seller_delegated false) has no seller agent: its events are skipped and
   * buyer-bound events from it have `from: null`. Sellers outside the principals file get a dynamic agent.
   */
  async route(event: WorkerEvent): Promise<Route> {
    const r: Partial<NonNullable<WorkerEvent["route"]>> = event.route || {};
    const sessionId = event.payload?.session_id;
    const buyer = this.registry.buyer;
    const ourBuyer = buyer.platform ? r.delegated !== false : !r.buyer_id || r.buyer_id === buyer.buyerId;
    const sellerOff = r.seller_delegated === false;
    if (r.to_role === "seller") {
      if (sellerOff) return { skip: "seller negotiates in chat (agent negotiation is off)" };
      const sellerId = r.seller_id || (sessionId ? this.sessionSeller.get(sessionId) : undefined);
      if (!sellerId) return { error: "seller-bound event without route.seller_id" };
      const found = await this.registry.resolveSeller(sellerId);
      if (found?.skip !== undefined) return { skip: found.skip };
      const to = found?.agent;
      if (!to) return { error: `unknown seller ${sellerId} (not in principals file)` };
      if (sessionId) this.sessionSeller.set(sessionId, sellerId);
      return { from: ourBuyer && !NOTICE_KINDS.has(event.kind) ? this.registry.buyer : null, to };
    }
    if (r.to_role === "buyer") {
      if (!ourBuyer) return { skip: `order not delegated to the buyer agent (buyer ${short(r.buyer_id)} negotiates in chat)` };
      const sellerId = r.seller_id || event.payload?.seller_id || (sessionId ? this.sessionSeller.get(sessionId) : undefined);
      if (sellerId && sessionId) this.sessionSeller.set(sessionId, sellerId);
      const from = sellerId && !sellerOff ? (await this.registry.resolveSeller(sellerId))?.agent ?? null : null;
      return { from, to: this.registry.buyer };
    }
    return { error: `unroutable event: route.to_role=${r.to_role}` };
  }

  async tick(): Promise<number> {
    const events = await this.api.events(this.limit);
    const blocked = new Set<string>(); // keep per-agent order: after a failure, skip that agent's later events
    let delivered = 0;
    for (const event of events) {
      if (this.since && new Date(event.created_at) < this.since) {
        await this.#skip(event, "backlog from before the runner started");
        continue;
      }
      let route: Route;
      try {
        route = await this.route(event);
      } catch (err) {
        this.#fail(event, (err as Error).message); // e.g. minting a seller token failed: retry next poll
        continue;
      }
      const { from, to, error, skip } = route;
      if (skip !== undefined) {
        await this.#skip(event, skip);
        continue;
      }
      if (error !== undefined) {
        this.#fail(event, error);
        continue;
      }
      if (blocked.has(to.id)) continue;
      if (NOTICE_KINDS.has(event.kind)) {
        if (to.role !== "seller" || !this.onNotice) {
          await this.#skip(event, "no notice handler for this agent");
          continue;
        }
        try {
          log.info(`notice ${event.kind}`, { to: to.id, order: short(event.payload?.order_id), event: short(event.id) });
          await this.onNotice(to, event);
          await this.api.ack(event.id);
          this.lastError.delete(event.id);
          delivered++;
        } catch (err) {
          blocked.add(to.id);
          this.#fail(event, (err as Error).message);
        }
        continue;
      }
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

  /** Ack without delivering: nobody here should act on this event. */
  async #skip(event: WorkerEvent, reason: string): Promise<void> {
    try {
      await this.api.ack(event.id);
      log.info(`skipped ${event.kind}`, { event: short(event.id), reason });
    } catch (err) {
      this.#fail(event, (err as Error).message);
    }
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
