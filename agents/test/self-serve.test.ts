// Self-serve businesses (doc/signup-contract.md, "Agents"): dynamic seller agents minted with the worker token,
// sellers that negotiate in chat, order.confirmed notices and the "Sold" email.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, REFRESH_BEFORE_MS } from "../src/agents.ts";
import type { Agent, SellerAgent } from "../src/agents.ts";
import { BackendError } from "../src/backend.ts";
import type { SellerAgentToken, WorkerEvent } from "../src/backend.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { SaleNotifier, businessFromResult, saleEmail } from "../src/notify.ts";
import type { EmailMessage } from "../src/notify.ts";
import type { McpToolClient } from "../src/mcp.ts";
import { localReceipt } from "../src/transport/index.ts";
import type { MessageHandler, Transport } from "../src/transport/index.ts";

process.env.LOG_SILENT ??= "1";

const BUYER = "11111111-1111-4111-8111-111111111111";
const STATIC = "33333333-3333-4333-8333-333333333333";
const OWNED = "44444444-4444-4444-8444-444444444444";
const CHAT = "55555555-5555-4555-8555-555555555555";

function setup(events: WorkerEvent[], mint: (id: string) => Promise<SellerAgentToken>) {
  const mints: string[] = [];
  const registry = new AgentRegistry(
    { buyer: { actor_id: BUYER, token: "b", scope: "buyer_agent" }, sellers: [{ seller_id: STATIC, name: "Bay Desk Co", token: "s" }], worker: { token: "w" } },
    undefined,
    { mintSellerToken: (id) => (mints.push(id), mint(id)) },
  );
  const added: string[] = [];
  registry.onNew = (a) => added.push(a.id);
  const acked: string[] = [];
  const sent: { from: string | null; to: string; id: string; token: string }[] = [];
  const notices: { to: string; id: string }[] = [];
  const transport: Transport = {
    name: "fake",
    async start() {},
    onMessage(_agent: Agent, _handler: MessageHandler) {},
    async send(from, to, event) {
      sent.push({ from: from?.id ?? null, to: to.id, id: event.id, token: to.token });
      return localReceipt(from, to, event);
    },
    async email() {},
    async close() {},
  };
  const api = {
    async events() {
      return events.filter((e) => !acked.includes(e.id));
    },
    async ack(id: string) {
      acked.push(id);
      return {};
    },
  };
  const dispatcher = new Dispatcher({
    api,
    transport,
    registry,
    onNotice: async (to: SellerAgent, event: WorkerEvent) => void notices.push({ to: to.id, id: event.id }),
  });
  return { dispatcher, registry, acked, sent, notices, mints, added };
}

const ev = (id: string, kind: WorkerEvent["kind"], to_role: "buyer" | "seller", seller_id: string, extra: Partial<NonNullable<WorkerEvent["route"]>> = {}): WorkerEvent => ({
  id,
  kind,
  created_at: new Date().toISOString(),
  payload: kind === "order.confirmed" ? { order_id: `order-${id}`, total_cents: 37150, title: "Desk" } : { session_id: `session-${seller_id}` },
  route: { to_role, seller_id, buyer_id: BUYER, delegated: true, ...extra },
});

const token = (id: string, n: number, expiresInMs = 24 * 3600_000): SellerAgentToken => ({
  token: `tok-${id}-${n}`,
  seller_id: id,
  name: "Jaxon's Desks",
  expires_at: new Date(Date.now() + expiresInMs).toISOString(),
});

test("a business outside the principals file gets a dynamic seller agent, minted once and cached", async () => {
  let n = 0;
  const { dispatcher, registry, acked, sent, mints, added } = setup(
    [ev("e1", "session.opened", "seller", OWNED), ev("e2", "offer.created", "buyer", OWNED), ev("e3", "counter.created", "seller", OWNED)],
    async (id) => token(id, ++n),
  );
  assert.equal(await dispatcher.tick(), 3);
  assert.deepEqual(mints, [OWNED], "minted once, then cached");
  assert.deepEqual(added, [`seller:${OWNED}`], "the runner is told about the new agent (mailbox + transport)");
  assert.deepEqual(sent.map((s) => [s.from, s.to, s.id]), [
    ["buyer", `seller:${OWNED}`, "e1"],
    [`seller:${OWNED}`, "buyer", "e2"],
    ["buyer", `seller:${OWNED}`, "e3"],
  ]);
  assert.equal(sent[0].token, `tok-${OWNED}-1`);
  const agent = registry.seller(OWNED)!;
  assert.equal(agent.dynamic, true);
  assert.equal(agent.name, "Jaxon's Desks");
  assert.equal(agent.slug, "jaxon-s-desks");
  assert.deepEqual(acked, ["e1", "e2", "e3"]);
  assert.ok(registry.all().some((a) => a.id === `seller:${OWNED}`));
});

test("dynamic token is re-minted 10 minutes before it expires (same agent object), and on demand", async () => {
  let n = 0;
  const { registry, mints } = setup([], async (id) => token(id, ++n, REFRESH_BEFORE_MS + 60_000));
  const first = (await registry.resolveSeller(OWNED))!.agent!;
  assert.equal(first.token, `tok-${OWNED}-1`);
  assert.equal((await registry.resolveSeller(OWNED))!.agent, first, "still fresh: cached");
  registry.now = () => Date.now() + 2 * 60_000; // now within 10 minutes of expiry
  const second = (await registry.resolveSeller(OWNED))!.agent!;
  assert.equal(second, first, "same agent, mailbox and identity");
  assert.equal(second.token, `tok-${OWNED}-2`);
  await registry.resolveSeller(OWNED, { refresh: true }); // e.g. a 401 mid-turn
  assert.equal(first.token, `tok-${OWNED}-3`);
  assert.deepEqual(mints, [OWNED, OWNED, OWNED]);
  // Static sellers are never minted.
  assert.equal((await registry.resolveSeller(STATIC))!.agent!.token, "s");
  assert.equal(mints.length, 3);
});

test("owner negotiates in chat: seller-bound events are skipped, buyer-bound events have no sender agent", async () => {
  const { dispatcher, acked, sent, mints } = setup(
    [
      ev("off1", "session.opened", "seller", CHAT, { seller_delegated: false }),
      ev("off2", "offer.created", "buyer", CHAT, { seller_delegated: false }),
      ev("nd1", "session.opened", "seller", OWNED), // route says delegated, but the business turned it off since
      ev("st1", "session.opened", "seller", STATIC, { seller_delegated: false }), // a static seller turned off
    ],
    async () => {
      throw new BackendError(403, "not_delegated", "Seller has not delegated negotiation");
    },
  );
  assert.equal(await dispatcher.tick(), 1);
  assert.deepEqual(sent.map((s) => [s.from, s.to, s.id]), [[null, "buyer", "off2"]]);
  assert.deepEqual(mints, [OWNED], "seller_delegated:false never mints");
  assert.deepEqual(acked, ["off1", "off2", "nd1", "st1"]);
});

test("mint failures other than not_delegated are retried (event not acked); unknown sellers are skipped", async () => {
  let fail = true;
  const { dispatcher, acked, sent } = setup(
    [ev("e1", "session.opened", "seller", OWNED), ev("gone", "session.opened", "seller", CHAT)],
    async (id) => {
      if (id === CHAT) throw new BackendError(404, "seller_not_found", "no such seller");
      if (fail) throw new BackendError(503, "database_error", "try again");
      return token(id, 1);
    },
  );
  assert.equal(await dispatcher.tick(), 0);
  assert.deepEqual(acked, ["gone"]);
  fail = false;
  assert.equal(await dispatcher.tick(), 1);
  assert.deepEqual(sent.map((s) => s.id), ["e1"]);
  assert.deepEqual(acked, ["gone", "e1"]);
});

test("order.confirmed is a notice: handed to the seller agent's notice handler, never sent as a turn", async () => {
  const { dispatcher, acked, sent, notices } = setup(
    [ev("o1", "order.confirmed", "seller", OWNED), ev("o2", "order.confirmed", "seller", STATIC), ev("o3", "order.confirmed", "seller", CHAT, { seller_delegated: false })],
    async (id) => token(id, 1),
  );
  assert.equal(await dispatcher.tick(), 2);
  assert.deepEqual(sent, [], "no transport send, so no brain turn");
  assert.deepEqual(notices, [
    { to: `seller:${OWNED}`, id: "o1" },
    { to: `seller:${STATIC}`, id: "o2" },
  ]);
  assert.deepEqual(acked, ["o1", "o2", "o3"]);
});

// ---------------------------------------------------------------- SaleNotifier

const seller: SellerAgent = { id: `seller:${OWNED}`, role: "seller", name: "Jaxon's Desks", slug: "jaxon-s-desks", token: "t", sellerId: OWNED, dynamic: true };
const platform: Agent = { id: "buyer", role: "buyer", name: "Buyer agent", slug: "buyer", token: "b", buyerId: BUYER, platform: true };
const order = (orderId = "ord-1"): WorkerEvent => ({
  id: `evt-${orderId}`,
  kind: "order.confirmed",
  created_at: new Date().toISOString(),
  payload: { order_id: orderId, reservation_id: "res-1", request_id: "req-1", seller_id: OWNED, total_cents: 37150, currency: "usd", title: "Desk + <chair>" },
  route: { to_role: "seller", seller_id: OWNED },
});

function notifier({ email = "owner@example.com" as string | null, hasMailbox = true, failFromSeller = false } = {}) {
  const emails: { from: string; message: EmailMessage }[] = [];
  const calls: string[] = [];
  const transport = {
    name: "fake",
    hasMailbox: () => hasMailbox,
    async email(from: Agent, message: EmailMessage) {
      if (failFromSeller && from.role === "seller") throw new Error("no identity");
      emails.push({ from: from.id, message });
    },
  } as unknown as Transport;
  const mcp = {
    async call(name: string) {
      calls.push(name);
      return { status: "ok", seller_id: OWNED, name: "Jaxon's Desks", owner_email: email, next: "" };
    },
  } as unknown as McpToolClient;
  return { sales: new SaleNotifier({ transport, mcpFor: async () => mcp, platform: () => platform }), emails, calls };
}

test("sale email: from the seller's own mailbox, numbers from the event, escaped, once per order", async () => {
  const { sales, emails, calls } = notifier();
  await sales.onOrder(seller, order());
  await sales.onOrder(seller, order()); // redelivered event
  assert.deepEqual(calls, ["get_business"]);
  assert.equal(emails.length, 1);
  const { from, message } = emails[0];
  assert.equal(from, `seller:${OWNED}`);
  assert.deepEqual(message.to, ["owner@example.com"]);
  assert.equal(message.subject, "Sold: Desk + <chair>, $371.50");
  assert.equal(message.idempotencyKey, "exchangent-sale-ord-1");
  assert.match(message.html, /Desk \+ &#60;chair&#62;/);
  assert.doesNotMatch(message.html, /<chair>/);
});

test("sale email: platform mailbox when the seller has none (local seller, or the email from it fails)", async () => {
  const local = notifier({ hasMailbox: false });
  await local.sales.onOrder(seller, order());
  assert.deepEqual(local.emails.map((e) => e.from), ["buyer"]);
  const failing = notifier({ failFromSeller: true });
  await failing.sales.onOrder(seller, order("ord-2"));
  assert.deepEqual(failing.emails.map((e) => [e.from, e.message.idempotencyKey]), [["buyer", "exchangent-sale-ord-2"]]);
});

test("sale email: skipped when the owner has no email (demo business), never throws", async () => {
  const { sales, emails } = notifier({ email: null });
  await sales.onOrder(seller, order());
  assert.equal(emails.length, 0);
  assert.deepEqual(businessFromResult({ business: { name: "X", owner_email: "a@b.co" } }), { name: "X", ownerEmail: "a@b.co" });
  assert.equal(saleEmail({ email: "a@b.co", business: "X", title: "T", totalCents: 100, orderId: "o" }).subject, "Sold: T, $1.00");
});
