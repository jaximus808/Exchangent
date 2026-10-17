import { toMessage } from "./index.mjs";
import { logger } from "../log.mjs";

const log = logger("transport:local");

/** In-process transport: zero external dependencies, no Inkbox keys. */
export class LocalTransport {
  name = "local";
  #handlers = new Map();

  onMessage(agent, handler) {
    this.#handlers.set(agent.id, handler);
  }

  async start() {}

  async send(fromAgent, toAgent, event) {
    const handler = this.#handlers.get(toAgent.id);
    if (!handler) throw new Error(`no local receiver for ${toAgent.id}`);
    const msg = toMessage(fromAgent, event);
    log.info("delivered", { from: fromAgent?.id, to: toAgent.id, kind: event.kind, event: event.id });
    await handler(msg);
  }

  async close() {}
}
