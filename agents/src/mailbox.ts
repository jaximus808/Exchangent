import { logger } from "./log.ts";
import type { Agent } from "./agents.ts";
import type { TransportMessage } from "./transport/index.ts";

const log = logger("mailbox");

/** Runs one brain turn for one event. */
export type MailboxHandler = (agent: Agent, event: TransportMessage) => unknown;

/** Which lane an event runs in. Events in one lane run strictly in order; lanes run concurrently. */
export type LaneKey = (event: TransportMessage) => string;

/** Every event in one lane: the agent's turns are strictly sequential (the default). */
export const SINGLE_LANE: LaneKey = () => "";

/**
 * Caps how many turns (claude -p processes) run at once across every mailbox. Shared by the runner;
 * acquire() resolves when a slot is free, and the returned function releases it.
 */
export class TurnLimiter {
  max: number;
  active: number;
  waiters: Array<() => void>;

  constructor(max = 4) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.waiters = [];
  }

  async acquire(): Promise<() => void> {
    // A released slot is handed straight to the next waiter (active stays the same), so a newcomer can never
    // take it in between and push the count over max.
    if (this.active < this.max) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

export interface MailboxOptions {
  maxSeen?: number;
  /** Lane per event (the buyer agent: one lane per request). Default: one lane for the whole agent. */
  laneKey?: LaneKey;
  /** Shared cap on concurrent turns across agents. Default: unlimited. */
  limiter?: TurnLimiter | null;
}

/**
 * One mailbox per agent. Events are grouped into lanes: each lane runs one turn at a time, in arrival order;
 * different lanes (e.g. two orders the buyer agent negotiates) run concurrently, within the shared turn limit.
 * Delivery is at-least-once, so the mailbox drops event ids it has already accepted.
 */
export class Mailbox {
  agent: Agent;
  onEvent: MailboxHandler;
  /** Events waiting, across all lanes (oldest first per lane). */
  queue: TransportMessage[];
  seen: Set<string>;
  maxSeen: number;
  /** True while any lane is draining. */
  running: boolean;
  idleWaiters: Array<() => void>;
  laneKey: LaneKey;
  limiter: TurnLimiter | null;
  #lanes = new Map<string, TransportMessage[]>();

  constructor(agent: Agent, onEvent: MailboxHandler, { maxSeen = 5000, laneKey = SINGLE_LANE, limiter = null }: MailboxOptions = {}) {
    this.agent = agent;
    this.onEvent = onEvent;
    this.queue = [];
    this.seen = new Set();
    this.maxSeen = maxSeen;
    this.running = false;
    this.idleWaiters = [];
    this.laneKey = laneKey;
    this.limiter = limiter;
  }

  /** Accept an event. Returns false if this event id was already accepted (duplicate). */
  push(event: TransportMessage): boolean {
    if (!event?.id) throw new Error("mailbox event needs an id");
    if (this.seen.has(event.id)) {
      log.info("duplicate skipped", { agent: this.agent.id, kind: event.kind, event: event.id });
      return false;
    }
    this.seen.add(event.id);
    if (this.seen.size > this.maxSeen) {
      const oldest = this.seen.values().next().value; // always defined: the set is not empty here
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.queue.push(event);
    const key = this.laneKey(event);
    const lane = this.#lanes.get(key);
    log.info("queued", { agent: this.agent.id, kind: event.kind, event: event.id, depth: this.queue.length });
    if (lane) {
      lane.push(event); // that lane is draining: it picks this event up in order
    } else {
      this.#lanes.set(key, [event]);
      this.running = true;
      void this.#drain(key);
    }
    return true;
  }

  async #drain(key: string): Promise<void> {
    const lane = this.#lanes.get(key)!; // created by push() just before draining
    while (lane.length) {
      const event = lane[0];
      const release = this.limiter ? await this.limiter.acquire() : null;
      try {
        await this.onEvent(this.agent, event);
      } catch (err) {
        log.error("turn failed", { agent: this.agent.id, kind: event.kind, event: event.id, error: (err as Error | undefined)?.message });
      } finally {
        release?.();
      }
      lane.shift();
      const i = this.queue.indexOf(event);
      if (i >= 0) this.queue.splice(i, 1);
    }
    this.#lanes.delete(key);
    if (this.#lanes.size === 0) {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  /** Resolves once every lane is empty and no turn is running. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
