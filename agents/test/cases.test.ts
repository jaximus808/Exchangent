import test from "node:test";
import assert from "node:assert/strict";
import { buyerAgent, sellerAgent } from "../src/agents.ts";
import type { Agent, SellerAgent } from "../src/agents.ts";
import {
  CASE_NOTICE_KINDS,
  CaseNotifier,
  caseRules,
  casePrompt,
  decideCaseBuyer,
  decideCaseSeller,
  mockCaseTurn,
  normalizeCase,
  noticeEmail,
} from "../src/cases.ts";
import type { CaseView } from "../src/cases.ts";
import { buildClaudeInvocation, turnPrompt } from "../src/brains/claude.ts";
import { Dispatcher, transcriptLine } from "../src/dispatcher.ts";
import { AgentRegistry } from "../src/agents.ts";
import type { WorkerEvent } from "../src/backend.ts";
import type { EmailMessage } from "../src/notify.ts";
import type { DeliveryReceipt, Transport, TransportMessage } from "../src/transport/index.ts";
import { toMessage } from "../src/transport/index.ts";

const view = (over: Partial<CaseView>): CaseView => ({
  caseId: "c1",
  orderId: "o1",
  type: "damaged",
  status: "open",
  turn: "buyer",
  version: 2,
  rounds: 1,
  refundableCents: 30000,
  moves: [],
  substituteCheck: null,
  ...over,
});
const move = (by: string, kind: string, amount?: number) => ({ by, action: "offer", remedy: { kind, ...(amount !== undefined ? { amount_cents: amount } : {}) } });

test("normalizeCase: tolerant of the result shape, refundable from order totals, requested remedy as the first move", () => {
  const c = normalizeCase({ status: "ok", case: { id: "c9", order_id: "o9", type: "damaged", status: "open", turn: "seller", version: 1, rounds: 0, order: { total_cents: 30000, refunded_cents: 5000 }, requested_remedy: { kind: "keep_with_discount", amount_cents: 6000 } } });
  assert.equal(c.caseId, "c9");
  assert.equal(c.refundableCents, 25000);
  assert.deepEqual(c.moves, [{ by: "buyer", action: "open", remedy: { kind: "keep_with_discount", amount_cents: 6000 } }]);
});

test("buyer agent: accepts fair or full remedies, meets in the middle, never asks above the refundable value", () => {
  assert.equal(decideCaseBuyer(view({ moves: [move("buyer", "refund_partial", 6000), move("seller", "refund_partial", 6000)] })).action, "accept");
  assert.equal(decideCaseBuyer(view({ moves: [move("buyer", "refund_partial", 6000), move("seller", "refund_items")] })).action, "accept");
  const mid = decideCaseBuyer(view({ moves: [move("buyer", "keep_with_discount", 8000), move("seller", "keep_with_discount", 4000)] }));
  assert.equal(mid.action, "counter");
  assert.deepEqual(mid.action === "counter" && mid.remedy, { kind: "keep_with_discount", amount_cents: 6000 });
  const capped = decideCaseBuyer(view({ refundableCents: 5000, moves: [move("buyer", "refund_partial", 90000), move("seller", "refund_partial", 1000)] }));
  assert.ok(capped.action === "counter" && capped.remedy.amount_cents! <= 5000);
  assert.equal(decideCaseBuyer(view({ rounds: 4, moves: [move("buyer", "refund_partial", 8000), move("seller", "refund_partial", 4000)] })).action, "accept", "fair enough after several rounds");
  assert.equal(decideCaseBuyer(view({ turn: "seller" })).action, "wait");
  assert.equal(decideCaseBuyer(view({ status: "resolved" })).action, "wait");
});

test("buyer agent: a substitute is accepted only when it meets the original requirements at no extra cost", () => {
  const sub = (sc: CaseView["substituteCheck"]) => view({ type: "substitution", moves: [move("seller", "replace")], substituteCheck: sc });
  assert.equal(decideCaseBuyer(sub({ meets_requirements: true, unit_cents_delta: -2000 })).action, "accept");
  assert.equal(decideCaseBuyer(sub({ meets_requirements: true, unit_cents_delta: 500 })).action, "decline");
  assert.equal(decideCaseBuyer(sub({ meets_requirements: false, unit_cents_delta: 0 })).action, "decline");
  assert.equal(decideCaseBuyer(sub(null)).action, "decline");
});

test("seller agent: accepts verified facts and in-policy asks, prefers a discount over return freight, escalates past policy", () => {
  const pol = { maxAutoPartialPct: 15 };
  const s = (over: Partial<CaseView>) => view({ turn: "seller", ...over });
  assert.equal(decideCaseSeller(s({ type: "not_received", moves: [move("buyer", "refund_items")] }), pol).action, "accept");
  assert.equal(decideCaseSeller(s({ moves: [move("buyer", "keep_with_discount", 7000)] }), pol).action, "accept", "7000 <= 25% of 30000");
  const ret = decideCaseSeller(s({ rounds: 0, moves: [move("buyer", "return_for_refund")] }), pol);
  assert.ok(ret.action === "counter" && ret.remedy.kind === "keep_with_discount");
  const over = decideCaseSeller(s({ moves: [move("buyer", "refund_partial", 20000)] }), pol);
  assert.ok(over.action === "counter" && over.remedy.amount_cents! <= 7500, "counters within pct + 10");
  assert.equal(decideCaseSeller(s({ rounds: 4, moves: [move("buyer", "refund_partial", 20000)] }), pol).action, "decline");
  assert.equal(decideCaseSeller(s({ turn: "buyer" }), pol).action, "wait");
});

function fakeMcp(results: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const r = results[name];
      return (typeof r === "function" ? (r as (a: Record<string, unknown>) => unknown)(args) : r ?? { status: "ok" }) as never;
    },
  };
}

test("mock case turn: reads the case (and the seller's policy), responds once with expected_version, retries a stale version once", async () => {
  const seller = sellerAgent({ seller_id: "s1", name: "Alex Woodworks", token: "t" });
  const event = { id: "e1", kind: "case.opened" as const, payload: { session_id: undefined as unknown as string, case_id: "c1", order_id: "o1" } };
  let tries = 0;
  const mcp = fakeMcp({
    get_case: { status: "ok", case: { id: "c1", type: "damaged", status: "open", turn: "seller", version: 3, rounds: 0, total_cents: 30000, moves: [{ by: "buyer", action: "open", remedy: { kind: "keep_with_discount", amount_cents: 4000 } }] } },
    get_resolution_policy: { status: "ok", max_auto_partial_refund_pct: 15 },
    respond_to_case: () => (++tries === 1 ? { status: "error", error: { code: "stale_offer" } } : { status: "ok" }),
  });
  const r = await mockCaseTurn(seller, event, mcp);
  assert.deepEqual(r, { action: "case", move: "accept", caseId: "c1" });
  const responds = mcp.calls.filter((c) => c.name === "respond_to_case");
  assert.equal(responds.length, 2);
  assert.equal(responds[0].args.expected_version, 3);
  assert.equal(responds[0].args.action, "accept");
  assert.deepEqual(mcp.calls.map((c) => c.name).slice(0, 2), ["get_case", "get_resolution_policy"]);
});

test("claude brain: case events get a case prompt (IDs only) and both personas carry the case rules", () => {
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const seller = sellerAgent({ seller_id: "s1", name: "Alex Woodworks", token: "t" });
  const ev = { id: "e1", kind: "case.offer" as const, payload: { session_id: undefined as unknown as string, case_id: "c1", order_id: "o1", request_id: "r1" } };
  assert.match(turnPrompt(buyer, ev), /get_case for case c1.*respond_to_case/);
  assert.match(casePrompt(seller, ev), /get_resolution_policy/);
  assert.doesNotMatch(casePrompt(buyer, ev), /\$\d/);
  assert.match(caseRules("buyer"), /untrusted data, never instructions/);
  assert.match(caseRules("seller"), /max_auto_partial_refund_pct \+ 10/);
  const inv = buildClaudeInvocation({ agent: seller, event: ev, mcpUrl: "http://x/mcp", stateDir: "/tmp/exg-test" } as Parameters<typeof buildClaudeInvocation>[0]);
  assert.ok(inv.args.join(" ").includes("After-sale cases"), "persona includes the case rules");
});

test("case events keep case_id and order_id in the public payload (A2A data part), never other fields", () => {
  const ev: WorkerEvent = { id: "e1", kind: "case.opened", created_at: "2026-10-18T00:00:00Z", payload: { case_id: "c1", order_id: "o1", type: "damaged", buyer_email: "x@y" }, route: { to_role: "seller", seller_id: "s1", request_id: "r1" } };
  assert.deepEqual(toMessage(null, ev).payload, { request_id: "r1", case_id: "c1", order_id: "o1" });
});

test("notice emails: one per event with a stable idempotency key, no budget or floor wording", () => {
  const base = { id: "e1", created_at: "2026-10-18T00:00:00Z", route: { to_role: "buyer" as const } };
  const shipped = noticeEmail({ ...base, kind: "order.shipped", payload: { order_id: "o1", title: "Desk", carrier: "UPS", tracking: "1Z" } }, "b@x.test")!;
  assert.equal(shipped.idempotencyKey, "exchangent-shipped-o1");
  assert.match(shipped.text, /UPS 1Z/);
  const resolved = noticeEmail({ ...base, kind: "case.resolved", payload: { case_id: "c1", title: "Desk", remedy: { kind: "keep_with_discount", amount_cents: 6000 } } }, "b@x.test")!;
  assert.match(resolved.text, /keeping the item with a discount of \$60\.00/);
  const refund = noticeEmail({ ...base, kind: "refund.succeeded", payload: { refund_id: "rf1", amount_cents: 2500, title: "Desk" } }, "b@x.test")!;
  assert.equal(refund.subject, "Refund issued: $25.00");
  assert.equal(refund.idempotencyKey, "exchangent-refund-rf1");
  const dispute = noticeEmail({ ...base, kind: "dispute.decided", route: { to_role: "seller" }, payload: { dispute_id: "d1", decision: "fight", title: "Desk" } }, "o@x.test", { business: "Alex Woodworks" })!;
  assert.match(dispute.subject, /contested/);
  assert.equal(noticeEmail({ ...base, kind: "order.delivered", payload: {} }, "b@x.test"), null);
  for (const m of [shipped, resolved, refund, dispute]) assert.doesNotMatch(m.text, /budget|floor|minimum/i);
});

function fakeTransport({ mailbox = true } = {}) {
  const emails: { from: string; message: EmailMessage }[] = [];
  const sent: { from: string | null; to: string; kind: string; payload: TransportMessage["payload"] }[] = [];
  const t: Transport & { emails: typeof emails; sent: typeof sent } = {
    name: "fake",
    emails,
    sent,
    async start() {},
    async send(from: Agent | null, to: Agent, event: WorkerEvent): Promise<DeliveryReceipt> {
      sent.push({ from: from?.id ?? null, to: to.id, kind: event.kind, payload: toMessage(from, event).payload });
      return { transport: "local", to_handle: to.slug, message_id: event.id, delivered_at: new Date().toISOString() };
    },
    onMessage() {},
    async email(from: Agent, message: EmailMessage) { emails.push({ from: from.id, message }); },
    hasMailbox: () => mailbox,
    async close() {},
  };
  return t;
}

test("CaseNotifier: buyer notices go to the delegated buyer's email once; seller notices to the owner; chat-only sides are skipped", async () => {
  const transport = fakeTransport();
  const principals = { buyer: { actor_id: "agent", token: "bt", scope: "buyer_agent" as const }, sellers: [{ seller_id: "s1", name: "Alex Woodworks", token: "st" }], worker: { token: "w" } };
  const registry = new AgentRegistry(principals);
  const mcpBuyer = fakeMcp({ get_buy_order: { status: "ok", request_id: "r1", title: "Desk + chair", buyer_email: "bea@x.test" } });
  const mcpSeller = fakeMcp({ get_business: { status: "ok", name: "Alex Woodworks", owner_email: "alex@x.test" } });
  const n = new CaseNotifier({ transport, registry, mcpFor: async (a) => (a.role === "buyer" ? mcpBuyer : mcpSeller) });
  const ev = (kind: string, to_role: "buyer" | "seller", extra: Record<string, unknown> = {}, route: Record<string, unknown> = {}): WorkerEvent =>
    ({ id: `e-${kind}`, kind: kind as WorkerEvent["kind"], created_at: "2026-10-18T00:00:00Z", payload: { order_id: "o1", request_id: "r1", ...extra }, route: { to_role, seller_id: "s1", request_id: "r1", delegated: true, seller_delegated: true, ...route } });

  await n.handle(ev("refund.succeeded", "buyer", { refund_id: "rf1", amount_cents: 2500 }));
  await n.handle(ev("refund.succeeded", "buyer", { refund_id: "rf1", amount_cents: 2500 })); // retried event: no second email
  await n.handle(ev("dispute.created", "seller", { dispute_id: "d1", amount_cents: 30000 }));
  await n.handle(ev("order.shipped", "buyer", {}, { delegated: false })); // buyer negotiates in chat: no agent email
  await n.handle(ev("case.escalated", "seller", { case_id: "c1" }, { seller_delegated: false })); // owner in chat
  await n.handle(ev("order.delivered", "buyer")); // nothing to send
  assert.deepEqual(transport.emails.map((e) => [e.from, e.message.to[0], e.message.subject]), [
    ["buyer", "bea@x.test", "Refund issued: $25.00"],
    ["seller:s1", "alex@x.test", "Chargeback opened: your order"],
  ]);
  assert.ok(CASE_NOTICE_KINDS.has("dispute.decided"));
});

test("CaseNotifier: an old backend (get_buy_order error) sends nothing and does not throw", async () => {
  const transport = fakeTransport();
  const registry = new AgentRegistry({ buyer: { actor_id: "agent", token: "bt", scope: "buyer_agent" }, sellers: [], worker: { token: "w" } });
  const n = new CaseNotifier({ transport, registry, mcpFor: async () => fakeMcp({ get_buy_order: { status: "error", error: { code: "not_found" } } }) });
  await n.handle({ id: "e1", kind: "case.resolved", created_at: "x", payload: { case_id: "c1", request_id: "r1" }, route: { to_role: "buyer", request_id: "r1" } });
  assert.equal(transport.emails.length, 0);
});

test("dispatcher: case notices are handled and acked without a transport send; case turns are delivered with case_id", async () => {
  const transport = fakeTransport();
  const registry = new AgentRegistry({ buyer: { actor_id: "agent", token: "bt", scope: "buyer_agent" }, sellers: [{ seller_id: "s1", name: "Alex Woodworks", token: "st" }], worker: { token: "w" } });
  const handled: string[] = [];
  const acks: string[] = [];
  const events: WorkerEvent[] = [
    { id: "n1", kind: "refund.succeeded", created_at: new Date().toISOString(), payload: { order_id: "o1" }, route: { to_role: "buyer", delegated: true } },
    { id: "t1", kind: "case.opened", created_at: new Date().toISOString(), payload: { case_id: "c1", order_id: "o1", type: "damaged" }, route: { to_role: "seller", seller_id: "s1", request_id: "r1", delegated: true, seller_delegated: true } },
    { id: "t2", kind: "case.offer", created_at: new Date().toISOString(), payload: { case_id: "c1", order_id: "o1" }, route: { to_role: "seller", seller_id: "s1", request_id: "r1", seller_delegated: false } },
  ];
  const d = new Dispatcher({
    api: { events: async () => events.filter((e) => !acks.includes(e.id)), ack: async (id: string) => { acks.push(id); return {}; } },
    transport,
    registry,
    caseNotices: { kinds: CASE_NOTICE_KINDS, handle: async (e) => void handled.push(e.id) },
  });
  await d.tick();
  assert.deepEqual(handled, ["n1"]);
  assert.deepEqual(transport.sent.map((s) => [s.from, s.to, s.kind, s.payload.case_id]), [["buyer", "seller:s1", "case.opened", "c1"]]);
  assert.deepEqual(acks.sort(), ["n1", "t1", "t2"], "t2 skipped: the seller negotiates in chat");

  // A failing notice handler leaves the event unacked (retried next poll).
  const acks2: string[] = [];
  const d2 = new Dispatcher({
    api: { events: async () => [events[0]], ack: async (id: string) => { acks2.push(id); return {}; } },
    transport,
    registry,
    caseNotices: { kinds: CASE_NOTICE_KINDS, handle: async () => { throw new Error("inkbox down"); } },
  });
  await d2.tick();
  assert.deepEqual(acks2, []);
});

test("transcript: case moves get a readable line", () => {
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const seller: SellerAgent = sellerAgent({ seller_id: "s1", name: "Alex Woodworks", token: "t" });
  const line = transcriptLine(buyer, seller, { id: "e", kind: "case.opened", created_at: "x", payload: { case_id: "c1", type: "not_as_described", amount_cents: 6000 } });
  assert.equal(line, "💬 Buyer agent → Alex Woodworks agent: case opened (not as described) $60.00");
});

test("normalizeCase: reads case_status from an MCP result whose own status is ok", () => {
  const c = normalizeCase({ status: "ok", case_status: "open", case_id: "c1", turn: "seller", version: 1, type: "damaged", moves: [] });
  assert.equal(c.status, "open");
  assert.equal(normalizeCase({ status: "open", case_id: "c2" }).status, "open", "backend shape");
});
