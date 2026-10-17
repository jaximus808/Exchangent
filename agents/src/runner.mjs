import { WorkerApi } from "./backend.mjs";
import { AgentRegistry } from "./agents.mjs";
import { readPrincipals } from "./config.mjs";
import { Dispatcher } from "./dispatcher.mjs";
import { Mailbox } from "./mailbox.mjs";
import { McpToolClient } from "./mcp.mjs";
import { createTransport } from "./transport/index.mjs";
import { createMockBrain } from "./brains/mock.mjs";
import { createClaudeBrain } from "./brains/claude.mjs";
import { logger } from "./log.mjs";

const log = logger("runner");

/** Wire dispatcher -> transport -> per-agent mailbox -> brain. Dependencies are injectable for tests. */
export async function createRunner(config, overrides = {}) {
  const api = overrides.api || new WorkerApi({ backendUrl: config.backendUrl, token: config.principals.worker.token });
  const registry = new AgentRegistry(config.principals, () => readPrincipals(config.principalsFile));
  const transport = overrides.transport || (await createTransport(config, { backend: api, ...(overrides.transportDeps || {}) }));

  const mcpClients = new Map();
  const mcpFor = async (agent) => {
    if (!mcpClients.has(agent.id)) mcpClients.set(agent.id, new McpToolClient({ url: config.mcpUrl, token: agent.token, agentId: agent.id }));
    return mcpClients.get(agent.id);
  };

  const brain =
    overrides.brain ||
    (config.brain === "claude"
      ? createClaudeBrain({ mcpUrl: config.mcpUrl, stateDir: config.stateDir, ...config.claude })
      : createMockBrain({ mcpFor }));

  const turns = [];
  const onTurn = async (agent, event) => {
    const t0 = Date.now();
    log.info(`turn start ${event.kind}`, { agent: agent.id, session: event.payload?.session_id, event: event.id });
    const result = await brain.turn(agent, event);
    turns.push({ agent: agent.id, kind: event.kind, eventId: event.id, result });
    log.info(`turn done -> ${result?.action}`, { agent: agent.id, ms: Date.now() - t0 });
    return result;
  };

  const mailboxes = new Map();
  const ensureAgent = (agent) => {
    if (mailboxes.has(agent.id)) return;
    const mb = new Mailbox(agent, onTurn);
    mailboxes.set(agent.id, mb);
    transport.onMessage(agent, (msg) => mb.push(msg));
  };
  registry.all().forEach(ensureAgent);
  registry.onNew = ensureAgent;

  const dispatcher = new Dispatcher({ api, transport, registry, pollMs: config.pollMs });

  return {
    api,
    registry,
    transport,
    brain,
    dispatcher,
    mailboxes,
    turns,
    async start() {
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
    async idle() {
      await Promise.all([...mailboxes.values()].map((m) => m.idle()));
    },
    async stop() {
      dispatcher.stop();
      await this.idle();
      await transport.close();
      await Promise.all([...mcpClients.values()].map((c) => c.close()));
    },
  };
}
