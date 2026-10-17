import { logger } from "./log.ts";
import type { Agent } from "./agents.ts";
import type { TransportMessage } from "./transport/index.ts";

const log = logger("mailbox");

/** Runs one brain turn for one event. */
export type MailboxHandler = (agent: Agent, event: TransportMessage) => unknown;

/**
 * One queue per agent, processed strictly one event at a time. Each event is one brain turn.
 * Delivery is at-least-once, so the mailbox drops event ids it has already accepted.
 */
export class Mailbox {
  agent: Agent;
  onEvent: MailboxHandler;
  queue: TransportMessage[];
  seen: Set<string>;
  maxSeen: number;
  running: boolean;
  idleWaiters: Array<() => void>;

  constructor(agent: Agent, onEvent: MailboxHandler, { maxSeen = 5000 }: { maxSeen?: number } = {}) {
    this.agent = agent;
    this.onEvent = onEvent;
    this.queue = [];
    this.seen = new Set();
    this.maxSeen = maxSeen;
    this.running = false;
    this.idleWaiters = [];
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
    log.info("queued", { agent: this.agent.id, kind: event.kind, event: event.id, depth: this.queue.length });
    if (!this.running) this.#drain();
    return true;
  }

  async #drain(): Promise<void> {
    this.running = true;
    while (this.queue.length) {
      const event = this.queue.shift()!; // the loop condition guarantees an element
      try {
        await this.onEvent(this.agent, event);
      } catch (err) {
        log.error("turn failed", { agent: this.agent.id, kind: event.kind, event: event.id, error: (err as Error | undefined)?.message });
      }
    }
    this.running = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** Resolves once the queue is empty and no turn is running. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
