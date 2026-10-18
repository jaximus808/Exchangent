import { WorkerApi } from "./backend.ts";
import { AgentRegistry } from "./agents.ts";
import type { Agent } from "./agents.ts";
import { readPrincipals } from "./config.ts";
import type { Config } from "./config.ts";
import { Dispatcher } from "./dispatcher.ts";
import { Mailbox } from "./mailbox.ts";
import { McpToolClient } from "./mcp.ts";
import { createTransport } from "./transport/index.ts";
import type { Transport, TransportMessage } from "./transport/index.ts";
import type { InkboxTransportDeps } from "./transport/inkbox.ts";
import { createMockBrain } from "./brains/mock.ts";
import { createClaudeBrain } from "./brains/claude.ts";
import { logger } from "./log.ts";
import { DealNotifier } from "./notify.ts";

const log = logger("runner");

/** The part of an inbound message a brain may use: the event kind and IDs. */
export type TurnEvent = Pick<TransportMessage, "id" | "kind" | "payload">;

/** Every brain turn returns at least the action it took. */
export interface TurnResult {
  action: string;
}

/** Runs one turn per event for an agent (BRAIN=mock | claude). */
export interface Brain<R extends TurnResult = TurnResult> {
  readonly name: string;
  turn(agent: Agent, event: TurnEvent): Promise<R>;
}

/** The worker endpoints the runner uses (WorkerApi; replaced in tests). */
export type RunnerApi = Pick<WorkerApi, "events" | "ack" | "registerSellerAgent">;

export interface RunnerOverrides {
  api?: RunnerApi;
  transport?: Transport;
  transportDeps?: InkboxTransportDeps;
  brain?: Brain;
}

export interface TurnRecord {
  agent: string;
  kind: TransportMessage["kind"];
  eventId: string;
  result: TurnResult;
}

export type Runner = Awaited<ReturnType<typeof createRunner>>;

/** Wire dispatcher -> transport -> per-agent mailbox -> brain. Dependencies are injectable for tests. */
export async function createRunner(config: Config, overrides: RunnerOverrides = {}) {
  const api = overrides.api || new WorkerApi({ backendUrl: config.backendUrl, token: config.principals.worker.token });
  const registry = new AgentRegistry(config.principals, () => readPrincipals(config.principalsFile));
  const transport = overrides.transport || (await createTransport(config, { backend: api, ...(overrides.transportDeps || {}) }));

  const mcpClients = new Map<string, McpToolClient>();
  const mcpFor = async (agent: Agent): Promise<McpToolClient> => {
    if (!mcpClients.has(agent.id)) mcpClients.set(agent.id, new McpToolClient({ url: config.mcpUrl, token: agent.token, agentId: agent.id }));
    return mcpClients.get(agent.id)!; // set just above if missing
  };

  const brain: Brain =
    overrides.brain ||
    (config.brain === "claude"
      ? createClaudeBrain({ mcpUrl: config.mcpUrl, stateDir: config.stateDir, ...config.claude })
      : createMockBrain({ mcpFor }));

  const notifier = new DealNotifier({ transport, mcpFor });
  const turns: TurnRecord[] = [];
  const onTurn = async (agent: Agent, event: TransportMessage) => {
    const t0 = Date.now();
    log.info(`turn start ${event.kind}`, { agent: agent.id, session: event.payload?.session_id, event: event.id });
    const result = await brain.turn(agent, event);
    turns.push({ agent: agent.id, kind: event.kind, eventId: event.id, result });
    log.info(`turn done -> ${result?.action}`, { agent: agent.id, ms: Date.now() - t0 });
    if (agent.role === "buyer") await notifier.afterTurn(agent, event, result);
    return result;
  };

  const mailboxes = new Map<string, Mailbox>();
  const ensureAgent = (agent: Agent): void => {
    if (mailboxes.has(agent.id)) return;
    const mb = new Mailbox(agent, onTurn);
    mailboxes.set(agent.id, mb);
    transport.onMessage(agent, (msg) => mb.push(msg));
  };
  registry.all().forEach(ensureAgent);
  registry.onNew = ensureAgent;

  const dispatcher = new Dispatcher({ api, transport, registry, pollMs: config.pollMs, since: config.skipBacklog ? new Date() : null });

  return {
    api,
    registry,
    transport,
    brain,
    dispatcher,
    mailboxes,
    turns,
    async start(): Promise<void> {
      log.info("starting", {
        transport: transport.name,
        brain: brain.name,
        backend: config.backendUrl,
        mcp: config.mcpUrl,
        agents: registry.all().map((a) => a.id).join(","),
      });
      await transport.start(registry.all());
      dispatcher.start();
    },
    async idle(): Promise<void> {
      await Promise.all([...mailboxes.values()].map((m) => m.idle()));
    },
    async stop(): Promise<void> {
      dispatcher.stop();
      await this.idle();
      await transport.close();
      await Promise.all([...mcpClients.values()].map((c) => c.close()));
    },
  };
}
