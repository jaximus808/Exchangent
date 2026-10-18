// doc/hardening-contract.md, "Agents": per-request lanes and the global turn cap, turn retries, the backlog age
// window, notices (session.closed, order.confirmed to the buyer), the backend sweep, the runner lock, and
// the backend client's timeout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { AgentRegistry, buyerAgent, sellerAgent } from "../src/agents.ts";
import type { Agent } from "../src/agents.ts";
import { WorkerApi } from "../src/backend.ts";
import type { WorkerEvent } from "../src/backend.ts";
import type { Config } from "../src/config.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { acquireRunnerLock } from "../src/lock.ts";
import { onLog } from "../src/log.ts";
import type { LogRecord } from "../src/log.ts";
import { Mailbox, TurnLimiter } from "../src/mailbox.ts";
import { createRunner, isRetryable, warnTokenExpiry } from "../src/runner.ts";
import type { Brain, TurnResult } from "../src/runner.ts";
import { localReceipt } from "../src/transport/index.ts";
import type { MessageHandler, Transport, TransportMessage } from "../src/transport/index.ts";

process.env.LOG_SILENT ??= "1";

const BUYER = "11111111-1111-4111-8111-111111111111";
const SELLER = "33333333-3333-4333-8333-333333333333";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (id: string, request_id?: string, session_id = `s-${request_id ?? id}`): TransportMessage => ({
  id,
  kind: "offer.created",
  payload: { session_id, ...(request_id ? { request_id } : {}) },
} as TransportMessage);

test("Mailbox lanes: one request's turns stay in order, different requests run in parallel", async () => {
  const buyer = buyerAgent({ actor_id: BUYER, token: "b", scope: "buyer_agent" });
  const log: string[] = [];
  const mb = new Mailbox(buyer, async (_a, e) => {
    log.push(`start ${e.id}`);
    await sleep(30);
    log.push(`end ${e.id}`);
  }, { laneKey: (e) => String(e.payload?.request_id) });
  mb.push(msg("a1", "r1"));
  mb.push(msg("a2", "r1"));
  mb.push(msg("b1", "r2"));
  await mb.idle();
  // r2 starts while r1's first turn is still running; r1's turns never overlap.
  assert.ok(log.indexOf("start b1") < log.indexOf("end a1"), "different requests run concurrently");
  assert.ok(log.indexOf("end a1") < log.indexOf("start a2"), "one request's turns are sequential");
  assert.equal(mb.queue.length, 0);
});

test("TurnLimiter: never more than MAX_CONCURRENT_TURNS turns at once across mailboxes", async () => {
  const limiter = new TurnLimiter(2);
  let active = 0;
  let peak = 0;
  const handler = async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(20);
    active--;
  };
  const a = new Mailbox(sellerAgent({ seller_id: "a", name: "A", token: "a" }), handler, { limiter });
  const b = new Mailbox(sellerAgent({ seller_id: "b", name: "B", token: "b" }), handler, { limiter });
  const c = new Mailbox(buyerAgent({ actor_id: BUYER, token: "x" }), handler, { limiter, laneKey: (e) => e.id });
  for (const [mb, ids] of [[a, ["a1", "a2"]], [b, ["b1"]], [c, ["c1", "c2", "c3"]]] as const) for (const id of ids) mb.push(msg(id, id));
  await Promise.all([a.idle(), b.idle(), c.idle()]);
  assert.equal(peak, 2);
});

test("isRetryable: process failures and throws retry; backend tool errors (string codes) do not", () => {
  assert.equal(isRetryable({ action: "error", code: 1 } as TurnResult), true);
  assert.equal(isRetryable({ action: "error", code: null } as TurnResult), true);
  assert.equal(isRetryable({ action: "error", code: "round_limit" } as TurnResult), false);
  assert.equal(isRetryable({ action: "offer" }), false);
});

function fakeTransport(): Transport & { handlers: Map<string, MessageHandler> } {
  const handlers = new Map<string, MessageHandler>();
  return {
    name: "fake",
    handlers,
    async start() {},
    onMessage(agent: Agent, handler: MessageHandler) { handlers.set(agent.id, handler); },
    async send(from, to, event) { return localReceipt(from, to, event); },
    async email() {},
    async close() {},
  };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    transport: "local",
    brain: "mock",
    backendUrl: "http://127.0.0.1:1",
    mcpUrl: "http://127.0.0.1:1/mcp",
    pollMs: 10_000,
    skipBacklog: false,
    principals: { buyer: { actor_id: BUYER, token: "b", scope: "buyer_agent" }, sellers: [{ seller_id: SELLER, name: "Bay Desk Co", token: "s" }], worker: { token: "w" } },
    principalsFile: "/nonexistent",
    stateDir: mkdtempSync(path.join(tmpdir(), "agents-hard-")),
    inkbox: {},
    claude: {},
    retryDelaysMs: [5, 5],
    sweepMs: 0,
    ...overrides,
  };
}

const quietApi = { async events() { return [] as WorkerEvent[]; }, async ack() { return {}; }, async registerSellerAgent() { return {}; } };

test("runner: a failed turn is retried with backoff, then given up; a string tool error is not retried", async () => {
  const results: Array<TurnResult | Error> = [{ action: "error", code: 1 } as TurnResult, new Error("claude crashed"), { action: "offer" }];
  let calls = 0;
  const brain: Brain = { name: "fake", async turn() { const r = results[calls++]; if (r instanceof Error) throw r; return r ?? { action: "noop" }; } };
  const transport = fakeTransport();
  const runner = await createRunner(baseConfig(), { api: quietApi, transport, brain });
  transport.handlers.get(`seller:${SELLER}`)!(msg("e1", "r1"));
  await runner.idle();
  assert.equal(calls, 3, "error result -> retry, throw -> retry, then success");
  assert.equal(runner.turns.at(-1)!.result.action, "offer");

  calls = 0;
  results.splice(0, results.length, { action: "error", code: "not_your_turn" } as TurnResult);
  transport.handlers.get(`seller:${SELLER}`)!(msg("e2", "r1"));
  await runner.idle();
  assert.equal(calls, 1, "a backend tool error is not retried");

  calls = 0;
  results.splice(0, results.length, { action: "error", code: 1 } as TurnResult, { action: "error", code: 1 } as TurnResult, { action: "error", code: 1 } as TurnResult, { action: "error", code: 1 } as TurnResult);
  const logs: LogRecord[] = [];
  const unsub = onLog((r) => logs.push(r));
  transport.handlers.get(`seller:${SELLER}`)!(msg("e3", "r1"));
  await runner.idle();
  unsub();
  assert.equal(calls, 3, "two retries (TURN_RETRY_DELAYS_MS has two delays), then it gives up");
  assert.ok(logs.some((l) => /giving up/.test(l.msg)));
  await runner.stop();
});

test("runner: the buyer agent serializes per request and runs requests concurrently", async () => {
  const log: string[] = [];
  const brain: Brain = { name: "fake", async turn(_a, e) { log.push(`start ${e.id}`); await sleep(25); log.push(`end ${e.id}`); return { action: "noop" }; } };
  const transport = fakeTransport();
  const runner = await createRunner(baseConfig(), { api: quietApi, transport, brain });
  const toBuyer = transport.handlers.get("buyer")!;
  toBuyer(msg("r1-a", "r1", "s1"));
  toBuyer({ id: "r1-b", kind: "session.declined", payload: { session_id: "s1" } } as TransportMessage); // no request_id: learned from s1
  toBuyer(msg("r2-a", "r2", "s2"));
  await runner.idle();
  assert.ok(log.indexOf("start r2-a") < log.indexOf("end r1-a"), "request r2 does not wait for r1");
  assert.ok(log.indexOf("end r1-a") < log.indexOf("start r1-b"), "session.declined for s1 waits in r1's lane");
  await runner.stop();
});

test("dispatcher: SKIP_BACKLOG skips only events older than the window; newer backlog is delivered", async () => {
  const registry = new AgentRegistry({ buyer: { actor_id: BUYER, token: "b", scope: "buyer_agent" }, sellers: [{ seller_id: SELLER, name: "Bay", token: "s" }], worker: { token: "w" } });
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const recent = new Date(Date.now() - 5 * 60_000).toISOString();
  const ev = (id: string, created_at: string): WorkerEvent => ({ id, kind: "session.opened", created_at, payload: { session_id: `s-${id}`, request_id: "r" }, route: { to_role: "seller", seller_id: SELLER, delegated: true } });
  const events = [ev("old", old), ev("recent", recent)];
  const acked: Array<[string, boolean]> = [];
  const sent: string[] = [];
  const transport = { ...fakeTransport(), async send(_f: Agent | null, _t: Agent, e: WorkerEvent) { sent.push(e.id); return localReceipt(null, _t, e); } };
  const api = { async events() { return events.filter((e) => !acked.some(([id]) => id === e.id)); }, async ack(id: string, d?: unknown) { acked.push([id, d !== undefined]); return {}; } };
  const d = new Dispatcher({ api, transport, registry, since: new Date(Date.now() - 15 * 60_000) });
  await d.tick();
  assert.deepEqual(sent, ["recent"], "the 5-minute-old event is delivered");
  assert.deepEqual(acked, [["old", false], ["recent", true]], "the hour-old one is acked without a delivery");
});

test("runner: session.closed and order.confirmed (buyer) are notices: no brain turn; buyer order gets the order email path", async () => {
  let turns = 0;
  const brain: Brain = { name: "fake", async turn() { turns++; return { action: "noop" }; } };
  const events: WorkerEvent[] = [
    { id: "n1", kind: "session.closed", created_at: new Date().toISOString(), payload: { session_id: "s1", request_id: "r1", reason: "another offer was accepted" }, route: { to_role: "seller", seller_id: SELLER, delegated: true } },
    { id: "n2", kind: "order.confirmed", created_at: new Date().toISOString(), payload: { order_id: "o1", request_id: "r1", total_cents: 30000, seller_name: "Bay Desk Co", title: "Desk" }, route: { to_role: "buyer", buyer_id: BUYER, request_id: "r1", delegated: true } },
  ];
  const acked: string[] = [];
  const api = { ...quietApi, async events() { return events.filter((e) => !acked.includes(e.id)); }, async ack(id: string) { acked.push(id); return {}; } };
  const transport = fakeTransport();
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (line: string) => lines.push(line);
  const runner = await createRunner(baseConfig({ pollMs: 5 }), { api, transport, brain });
  const handled: string[] = [];
  runner.noticeHandlers.set("order.confirmed", async (to, e) => { handled.push(`${to.role}:${e.id}`); });
  try {
    await runner.start();
    await new Promise<void>((resolve) => { const t = setInterval(() => { if (acked.length === 2) { clearInterval(t); resolve(); } }, 5); });
  } finally {
    console.log = origLog;
    await runner.stop();
  }
  assert.deepEqual(acked.sort(), ["n1", "n2"]);
  assert.equal(turns, 0, "notices never run a brain turn");
  assert.deepEqual(handled, ["buyer:n2"], "order.confirmed to the buyer reaches the buyer handler");
  assert.ok(lines.some((l) => /Bay Desk Co agent: closed \(another offer was accepted\)/.test(l)), "session.closed transcript line");
});

test("runner: sweeps the backend every SWEEP_MS, and stops quietly when the route is missing (404 -> null)", async () => {
  let sweeps = 0;
  let missing = false;
  const api = { ...quietApi, async sweep() { sweeps++; return missing ? null : { released: 0, expired: 0 }; } };
  const runner = await createRunner(baseConfig({ sweepMs: 10 }), { api, transport: fakeTransport(), brain: { name: "fake", async turn() { return { action: "noop" }; } } });
  await runner.start();
  await sleep(45);
  assert.ok(sweeps >= 2, `swept ${sweeps} times`);
  missing = true;
  await sleep(30);
  const after = sweeps;
  await sleep(40);
  assert.equal(sweeps, after, "after a 404 the runner stops sweeping");
  await runner.stop();
});

test("WorkerApi.sweep: 404 means 'no sweep route on this backend' (null); other errors throw", async () => {
  const api = (status: number) => new WorkerApi({ backendUrl: "http://x", token: "w", fetchImpl: (async () => new Response(JSON.stringify(status === 200 ? { data: { released: 1 } } : { error: { code: "x", message: "y" } }), { status })) as typeof fetch });
  assert.deepEqual(await api(200).sweep(), { released: 1 });
  assert.equal(await api(404).sweep(), null);
  await assert.rejects(api(500).sweep(), /backend 500/);
});

test("WorkerApi: every call is aborted after timeoutMs", async () => {
  const hang = (async (_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const api = new WorkerApi({ backendUrl: "http://x", token: "w", fetchImpl: hang, timeoutMs: 20 });
  const t0 = Date.now();
  await assert.rejects(api.events(), /abort|timeout/i);
  assert.ok(Date.now() - t0 < 1000);
});

test("runner lock: a second runner is refused while the first heartbeats; a dead or stale lock is taken over", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agents-lock-"));
  const first = acquireRunnerLock(dir, { heartbeatMs: 0 });
  assert.throws(() => acquireRunnerLock(dir, { pid: 999_999, host: "other-host", heartbeatMs: 0 }), /another runner is already running/);
  first.release();
  const second = acquireRunnerLock(dir, { pid: 4242, host: "other-host", heartbeatMs: 0 });
  second.release();
  // A lock left by a dead process on this host is stale.
  writeFileSync(path.join(dir, "runner.lock"), JSON.stringify({ pid: 999_999, host: hostname(), started_at: "x", heartbeat_at: new Date().toISOString() }));
  acquireRunnerLock(dir, { heartbeatMs: 0 }).release();
  // A lock from another host whose heartbeat stopped long ago is stale.
  writeFileSync(path.join(dir, "runner.lock"), JSON.stringify({ pid: 1, host: "container", started_at: "x", heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  acquireRunnerLock(dir, { heartbeatMs: 0 }).release();
});


test("warnTokenExpiry: warns for tokens expiring within 24 h when the principals file records expiry", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const principals: Config["principals"] = JSON.parse(JSON.stringify({
    expires_at: "2026-10-21T03:05:20Z",
    buyer: { actor_id: BUYER, token: "b" },
    sellers: [{ seller_id: SELLER, name: "Bay", token: "s", expires_at: "2026-10-25T00:00:00Z" }],
    worker: { token: "w" },
  }));
  assert.deepEqual(warnTokenExpiry(principals, now), ["principals"]);
  assert.deepEqual(warnTokenExpiry({ buyer: { actor_id: BUYER, token: "b" }, sellers: [], worker: { token: "w" } }, now), [], "no expiry data: no warning");
});
