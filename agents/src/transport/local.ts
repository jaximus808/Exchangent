import { toMessage } from "./index.ts";
import type { MessageHandler, Transport } from "./index.ts";
import type { Agent } from "../agents.ts";
import type { WorkerEvent } from "../backend.ts";
import type { EmailMessage } from "../notify.ts";
import { logger } from "../log.ts";

const log = logger("transport:local");

/** In-process transport: zero external dependencies, no Inkbox keys. */
export class LocalTransport implements Transport {
  name = "local";
  #handlers = new Map<string, MessageHandler>();

  onMessage(agent: Agent, handler: MessageHandler): void {
    this.#handlers.set(agent.id, handler);
  }

  async start(): Promise<void> {}

  async send(fromAgent: Agent | null, toAgent: Agent, event: WorkerEvent): Promise<void> {
    const handler = this.#handlers.get(toAgent.id);
    if (!handler) throw new Error(`no local receiver for ${toAgent.id}`);
    const msg = toMessage(fromAgent, event);
    log.info("delivered", { from: fromAgent?.id, to: toAgent.id, kind: event.kind, event: event.id });
    await handler(msg);
  }

  async email(from: Agent, message: EmailMessage): Promise<void> {
    log.info("email (local transport: not sent)", { from: from.id, subject: message.subject });
  }

  async close(): Promise<void> {}
}
