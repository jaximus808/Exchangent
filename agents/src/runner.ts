import { WorkerApi } from "./backend.ts";
import type { WorkerEvent } from "./backend.ts";
import { AgentRegistry } from "./agents.ts";
import type { Agent } from "./agents.ts";
import { readPrincipals } from "./config.ts";
import type { Config, Principals } from "./config.ts";
import { Dispatcher, NOTICE_KINDS } from "./dispatcher.ts";
import { Mailbox, SINGLE_LANE, TurnLimiter } from "./mailbox.ts";
import type { LaneKey } from "./mailbox.ts";
import { McpToolClient } from "./mcp.ts";
import { createTransport } from "./transport/index.ts";
import type { Transport, TransportMessage } from "./transport/index.ts";
import type { InkboxTransportDeps } from "./transport/inkbox.ts";
import { createMockBrain } from "./brains/mock.ts";
import { createClaudeBrain } from "./brains/claude.ts";
import { logger } from "./log.ts";
import { DealNotifier, OrderNotifier, SaleNotifier } from "./notify.ts";
import { CASE_NOTICE_KINDS, CaseNotifier } from "./cases.ts";
import { InboundResponder } from "./inbound.ts";

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

/** The worker endpoints the runner uses (WorkerApi; replaced in tests). Without mintSellerToken, only static sellers. */
export type RunnerApi = Pick<WorkerApi, "events" | "ack" | "registerSellerAgent"> & Partial<Pick<WorkerApi, "mintSellerToken" | "sweep" | "buyerRequestsByEmail" | "sellerOwner">>;

/** A turn failed because the agent's token was rejected (expired or revoked). */
export function isUnauthorized(err: unknown): boolean {
  return /\b401\b|unauthori[sz]ed/i.test((err as Error | null | undefined)?.message || "");
}

/**
 * Whether a failed turn is worth retrying: a thrown error (crash, timeout) or a Claude process failure
 * (numeric exit code). A mock brain's tool error carries the backend's string code (not_your_turn,
 * round_limit, too_many_requests, ...), which a retry would only repeat.
 */
export function isRetryable(result: TurnResult | undefined): boolean {
  const r = result as { action?: string; code?: unknown } | undefined;
  return r?.action === "error" && typeof r.code !== "string";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for http(s)://localhost and 127.x backends (local rehearsal); false for deployed ones. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host.startsWith("127.") || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

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
  const minter = api.mintSellerToken ? { mintSellerToken: api.mintSellerToken.bind(api) } : undefined;
  const registry = new AgentRegistry(config.principals, () => readPrincipals(config.principalsFile), minter);
  const transport = overrides.transport || (await createTransport(config, { backend: api, ...(overrides.transportDeps || {}) }));

  const mcpClients = new Map<string, McpToolClient>();
  const mcpFor = async (agent: Agent): Promise<McpToolClient> => {
    const existing = mcpClients.get(agent.id);
    if (existing && existing.token !== agent.token) await existing.close(); // re-minted token: reconnect with it
    if (!existing || existing.token !== agent.token) mcpClients.set(agent.id, new McpToolClient({ url: config.mcpUrl, token: agent.token, agentId: agent.id }));
    return mcpClients.get(agent.id)!; // set just above if missing
  };

  const brain: Brain =
    overrides.brain ||
    (config.brain === "claude"
      ? createClaudeBrain({ mcpUrl: config.mcpUrl, stateDir: config.stateDir, ...config.claude })
      : createMockBrain({ mcpFor }));

  const notifier = new DealNotifier({ transport, mcpFor });
  const sales = new SaleNotifier({ transport, mcpFor, platform: () => registry.buyer });
  const orders = new OrderNotifier({ transport, mcpFor });
  const caseNotifier = new CaseNotifier({ transport, registry, mcpFor, sellerOwner: api.sellerOwner ? (id) => api.sellerOwner!(id) : undefined }); // after-sale notices (cases.ts)
  const turns: TurnRecord[] = [];
  const retryDelays = config.retryDelaysMs ?? [2000, 10000];

  /** One brain turn; a dynamic seller whose token was rejected is re-minted and the turn retried once. */
  const runTurn = async (agent: Agent, event: TransportMessage): Promise<TurnResult> => {
    try {
      return await brain.turn(agent, event);
    } catch (err) {
      if (agent.role !== "seller" || !agent.dynamic || !isUnauthorized(err)) throw err;
      const fresh = await registry.resolveSeller(agent.sellerId, { refresh: true });
      if (!fresh?.agent) return log.info("seller token not renewed; turn dropped", { agent: agent.id, reason: fresh?.skip }), { action: "noop" };
      return await brain.turn(fresh.agent, event);
    }
  };

  const onTurn = async (agent: Agent, event: TransportMessage) => {
    if (NOTICE_KINDS_FOR_TURNS.has(event.kind)) return { action: "noop" }; // a notice, never a turn (the dispatcher handles it)
    const t0 = Date.now();
    log.info(`turn start ${event.kind}`, { agent: agent.id, session: event.payload?.session_id, event: event.id });
    let result: TurnResult | undefined;
    // A failed turn is retried with backoff (TURN_RETRY_DELAYS_MS); the event was already acked, so without a
    // retry the negotiation would wait on this agent forever.
    for (let attempt = 0; ; attempt++) {
      try {
        result = await runTurn(agent, event);
        if (!isRetryable(result) || attempt >= retryDelays.length) break;
        log.warn("turn failed; retrying", { agent: agent.id, event: event.id, attempt: attempt + 1, in_ms: retryDelays[attempt] });
      } catch (err) {
        if (isUnauthorized(err) || attempt >= retryDelays.length) {
          log.error("turn failed; giving up (the session is stalled until the next event)", { agent: agent.id, kind: event.kind, event: event.id, error: (err as Error).message });
          throw err;
        }
        log.warn("turn threw; retrying", { agent: agent.id, event: event.id, attempt: attempt + 1, in_ms: retryDelays[attempt], error: (err as Error).message });
      }
      await sleep(retryDelays[attempt]);
    }
    if (isRetryable(result)) log.error("turn failed; giving up (the session is stalled until the next event)", { agent: agent.id, kind: event.kind, event: event.id });
    if (!result) result = { action: "noop" };
    turns.push({ agent: agent.id, kind: event.kind, eventId: event.id, result });
    log.info(`turn done -> ${result?.action}`, { agent: agent.id, ms: Date.now() - t0 });
    if (agent.role === "buyer") await notifier.afterTurn(agent, event, result);
    return result;
  };

  // The platform buyer agent negotiates every delegated order: one lane per request, so a slow turn on one order
  // never holds up another. session.declined carries only session_id, so remember which request each session is.
  const sessionRequest = new Map<string, string>();
  const buyerLane: LaneKey = (msg) => {
    const p = msg.payload || {};
    if (p.session_id && p.request_id) sessionRequest.set(p.session_id, p.request_id);
    const request = p.request_id || (p.session_id ? sessionRequest.get(p.session_id) : undefined);
    return request ? `request:${request}` : p.session_id ? `session:${p.session_id}` : "";
  };
  const limiter = new TurnLimiter(config.maxConcurrentTurns ?? 4);
  const mailboxes = new Map<string, Mailbox>();
  const ensureAgent = (agent: Agent): void => {
    if (mailboxes.has(agent.id)) return;
    const mb = new Mailbox(agent, onTurn, { laneKey: agent.role === "buyer" ? buyerLane : SINGLE_LANE, limiter });
    mailboxes.set(agent.id, mb);
    transport.onMessage(agent, (msg) => mb.push(msg));
  };
  registry.all().forEach(ensureAgent);
  registry.onNew = ensureAgent;

  /** Notices: emails and logs, never brain turns. Features register more handlers by kind (noticeHandlers). */
  const noticeHandlers = new Map<string, (to: Agent, event: WorkerEvent) => Promise<void>>([
    ["order.confirmed", async (to, event) => {
      if (to.role === "seller") return sales.onOrder(to, event);
      return orders.onOrder(to, event);
    }],
    ["session.closed", async (to, event) => {
      const reason = String(event.payload?.reason || "closed");
      log.info("session closed", { agent: to.id, session: event.payload?.session_id, reason });
      console.log(`💬 Exchangent → ${to.role === "seller" ? `${to.name} agent` : to.name}: closed (${reason})`);
    }],
  ]);
  const onNotice = async (to: Agent, event: WorkerEvent): Promise<void> => {
    const handler = noticeHandlers.get(event.kind);
    if (handler) return handler(to, event);
    log.info(`notice ${event.kind}: no handler`, { agent: to.id, event: event.id });
  };

  const backlogMinutes = config.skipBacklogMinutes ?? 15;
  const dispatcher = new Dispatcher({
    api,
    transport,
    registry,
    pollMs: config.pollMs,
    since: config.skipBacklog ? new Date(Date.now() - backlogMinutes * 60_000) : null,
    onNotice,
    caseNotices: { kinds: CASE_NOTICE_KINDS, handle: (event) => caseNotifier.handle(event) },
  });

  // Email your agent (inbound.ts): status replies to the account owner. Inkbox only; off when INBOUND_POLL_MS=0.
  const inbound = new InboundResponder({
    transport,
    registry,
    api: { buyerRequestsByEmail: (email) => (api.buyerRequestsByEmail ? api.buyerRequestsByEmail(email) : Promise.resolve([])) },
    mcpFor,
    stateDir: config.stateDir,
    webUrl: config.webUrl || "https://web-five-jet-34.vercel.app",
    pollMs: config.inboundPollMs || 30000,
  });

  // The backend sweeps stale holds and past-deadline requests when asked (POST /worker/sweep). A backend
  // without that route answers 404 and the sweep is switched off quietly.
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const sweepMs = config.sweepMs ?? 60000;
  let sweepOff = !api.sweep || sweepMs <= 0;
  const sweep = async (): Promise<void> => {
    if (sweepOff || !api.sweep) return;
    try {
      const r = await api.sweep();
      if (r === null) {
        sweepOff = true;
        return log.info("backend has no sweep route yet; sweeping off");
      }
    } catch (err) {
      log.warn("sweep failed (will retry)", { error: (err as Error).message });
    }
  };

  return {
    api,
    registry,
    transport,
    brain,
    dispatcher,
    mailboxes,
    turns,
    noticeHandlers,
    sweep,
    async start(): Promise<void> {
      if (brain.name === "mock" && !isLocalUrl(config.backendUrl)) {
        log.warn("BRAIN=mock against a deployed backend: agents follow a script, not Claude. Set BRAIN=claude for real negotiation.", { backend: config.backendUrl });
      }
      warnTokenExpiry(config.principals);
      log.info("starting", {
        transport: transport.name,
        brain: brain.name,
        backend: config.backendUrl,
        mcp: config.mcpUrl,
        agents: registry.all().map((a) => a.id).join(","),
      });
      await transport.start(registry.all());
      dispatcher.start();
      if ((config.inboundPollMs ?? 30000) > 0) inbound.start();
      if (!sweepOff) {
        sweepTimer = setInterval(() => void sweep(), sweepMs);
        sweepTimer.unref?.();
      }
    },
    async idle(): Promise<void> {
      await Promise.all([...mailboxes.values()].map((m) => m.idle()));
    },
    async stop(): Promise<void> {
      if (sweepTimer) clearInterval(sweepTimer);
      dispatcher.stop();
      await inbound.stop();
      await this.idle();
      await transport.close();
      await Promise.all([...mcpClients.values()].map((c) => c.close()));
    },
  };
}

/** Notice kinds never become brain turns, even if a transport delivers one to a mailbox. */
const NOTICE_KINDS_FOR_TURNS: ReadonlySet<string> = NOTICE_KINDS;

/**
 * Warn at startup when a principals token expires within 24 h (or already has), when the file records expiry
 * (`expires_at` at the top level or on a principal). Without expiry data, a 401 from the backend is the signal.
 */
export function warnTokenExpiry(principals: Principals, now: number = Date.now()): string[] {
  const p = principals as Principals & { expires_at?: unknown };
  const seen: Array<[string, unknown]> = [["principals", p.expires_at], ["worker", (p.worker as { expires_at?: unknown }).expires_at], ["buyer", (p.buyer as { expires_at?: unknown }).expires_at]];
  for (const s of p.sellers || []) seen.push([`seller ${s.name}`, (s as { expires_at?: unknown }).expires_at]);
  const warned: string[] = [];
  for (const [who, at] of seen) {
    const t = typeof at === "string" ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t - now < 24 * 3600_000) {
      warned.push(who);
      log.warn(t <= now ? `${who} token has expired` : `${who} token expires within 24 h`, {
        expires_at: String(at),
        fix: "run `npm run agents:tokens` in backend/, then restart the runner",
      });
    }
  }
  return warned;
}
