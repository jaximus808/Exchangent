import { logger } from "./log.mjs";

const log = logger("mailbox");

/**
 * One queue per agent, processed strictly one event at a time. Each event is one brain turn.
 * Delivery is at-least-once, so the mailbox drops event ids it has already accepted.
 */
export class Mailbox {
  constructor(agent, onEvent, { maxSeen = 5000 } = {}) {
    this.agent = agent;
    this.onEvent = onEvent;
    this.queue = [];
    this.seen = new Set();
    this.maxSeen = maxSeen;
    this.running = false;
    this.idleWaiters = [];
  }

  /** Accept an event. Returns false if this event id was already accepted (duplicate). */
  push(event) {
    if (!event?.id) throw new Error("mailbox event needs an id");
    if (this.seen.has(event.id)) {
      log.info("duplicate skipped", { agent: this.agent.id, kind: event.kind, event: event.id });
      return false;
    }
    this.seen.add(event.id);
    if (this.seen.size > this.maxSeen) this.seen.delete(this.seen.values().next().value);
    this.queue.push(event);
    log.info("queued", { agent: this.agent.id, kind: event.kind, event: event.id, depth: this.queue.length });
    if (!this.running) this.#drain();
    return true;
  }

  async #drain() {
    this.running = true;
    while (this.queue.length) {
      const event = this.queue.shift();
      try {
        await this.onEvent(this.agent, event);
      } catch (err) {
        log.error("turn failed", { agent: this.agent.id, kind: event.kind, event: event.id, error: err?.message });
      }
    }
    this.running = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** Resolves once the queue is empty and no turn is running. */
  idle() {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
