import test from "node:test";
import assert from "node:assert/strict";
import { buyerAgent, sellerAgent } from "../src/agents.ts";
import { DealNotifier, OrderNotifier, dealEmail, dealFromOrder, dealSafety, readyOfferId } from "../src/notify.ts";
import type { EmailMessage } from "../src/notify.ts";
import type { McpToolClient } from "../src/mcp.ts";
import type { Transport } from "../src/transport/index.ts";

const OFFER = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
const order = (email: string | null) => ({
  status: "ok",
  request_id: "req-1",
  title: "Desk + ergonomic chair",
  buyer_email: email,
  budget_cents: 40000,
  sessions: [
    { session_id: "s1", seller_name: "Mission Ergonomics", current_offer: { offer_id: "other", total_cents: 42500 } },
    { session_id: "s2", seller_name: "Bay Desk Co", current_offer: { offer_id: OFFER, total_cents: 37150 } },
  ],
});

test("readyOfferId: mock and Claude brain results", () => {
  assert.equal(readyOfferId({ action: "ready", offerId: OFFER } as never), OFFER);
  assert.equal(readyOfferId({ action: "claude", summary: `Countered twice. READY TO RESERVE: ${OFFER}` } as never), OFFER);
  assert.equal(readyOfferId({ action: "claude", summary: "Countered at $350." } as never), null);
  assert.equal(readyOfferId({ action: "counter" }), null);
});

test("deal email: numbers come from the order, HTML is escaped, one key per order", () => {
  const deal = dealFromOrder(order("me@example.com"), OFFER)!;
  assert.deepEqual([deal.seller, deal.totalCents, deal.email], ["Bay Desk Co", 37150, "me@example.com"]);
  const mail = dealEmail({ ...deal, email: "me@example.com", title: "<b>x</b>" });
  assert.equal(mail.subject, "Deal reached: Bay Desk Co, $371.50");
  assert.equal(mail.idempotencyKey, "exchangent-deal-req-1");
  assert.ok(!mail.html.includes("<b>x</b>") && mail.html.includes("&#60;b&#62;x"));
  assert.equal(dealFromOrder(order(null), "missing"), null);
});

test("DealNotifier: emails once per order, skips buyers without email, never throws", async () => {
  const sent: EmailMessage[] = [];
  let email: string | null = "me@example.com";
  let fail = false;
  const transport = { async email(_from: unknown, m: EmailMessage) { if (fail) throw new Error("402"); sent.push(m); } } as unknown as Transport;
  const mcp = { async call() { return order(email); } } as unknown as McpToolClient;
  const n = new DealNotifier({ transport, mcpFor: async () => mcp });
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const ev = { id: "e1", kind: "offer.created" as const, payload: { session_id: "s2", request_id: "req-1" } };
  const ready = { action: "ready", offerId: OFFER } as never;

  await n.afterTurn(sellerAgent({ seller_id: "s", name: "Bay", token: "x" }), ev, ready);
  assert.equal(sent.length, 0, "only buyer turns");
  fail = true;
  await n.afterTurn(buyer, ev, ready);
  assert.equal(sent.length, 0);
  fail = false;
  await n.afterTurn(buyer, ev, ready); // retried after the failure
  await n.afterTurn(buyer, ev, ready); // deduped
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["me@example.com"]);

  email = null;
  await n.afterTurn(buyer, { ...ev, payload: { session_id: "s2", request_id: "req-2" } }, ready);
  assert.equal(sent.length, 1, "no email on file");
});

test("DealNotifier: a different, later deal on the same order sends one 'better deal' email", async () => {
  const sent: EmailMessage[] = [];
  const transport = { async email(_from: unknown, m: EmailMessage) { sent.push(m); } } as unknown as Transport;
  const LATE = "1b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e9";
  const withLate = { ...order("me@example.com"), sessions: [...order("me@example.com").sessions, { session_id: "s3", seller_name: "Alex Woodworks", current_offer: { offer_id: LATE, total_cents: 30000 } }] };
  // The late, cheaper offer arrives after the first deal (the safety check would hold back a deal email while a
  // cheaper open offer already exists).
  let snapshot: unknown = order("me@example.com");
  const mcp = { async call() { return snapshot; } } as unknown as McpToolClient;
  const n = new DealNotifier({ transport, mcpFor: async () => mcp });
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const ev = { id: "e1", kind: "offer.created" as const, payload: { session_id: "s2", request_id: "req-1" } };
  await n.afterTurn(buyer, ev, { action: "ready", offerId: OFFER } as never);
  snapshot = withLate;
  await n.afterTurn(buyer, ev, { action: "ready", offerId: LATE } as never);
  await n.afterTurn(buyer, ev, { action: "ready", offerId: LATE } as never);
  assert.deepEqual(sent.map((m) => [m.subject, m.idempotencyKey]), [
    ["Deal reached: Bay Desk Co, $371.50", "exchangent-deal-req-1"],
    ["Better deal: Alex Woodworks, $300.00", `exchangent-deal-req-1-${LATE}`],
  ]);
});

test("dealSafety: the agent's pick must be a current open offer, within budget, and not beaten by >1%", () => {
  const base = order("me@example.com"); // Mission 42500 (other), Bay 37150 (OFFER), budget 40000
  assert.deepEqual(dealSafety(base, OFFER), { ok: true });
  assert.equal(dealSafety(base, "other").ok, false, "over budget (42500 > 40000)");
  assert.match((dealSafety(base, "nope") as { reason: string }).reason, /not a current open offer/);
  const injected = { ...base, sessions: [...base.sessions, { session_id: "s3", seller_name: "Cheaper Co", current_offer: { offer_id: "c3", total_cents: 30000 } }] };
  assert.match((dealSafety(injected, OFFER) as { reason: string }).reason, /cheaper open offer exists \(Cheaper Co\)/);
  const withinOnePct = { ...base, sessions: [...base.sessions, { session_id: "s3", seller_name: "Close Co", current_offer: { offer_id: "c3", total_cents: 36900 } }] };
  assert.deepEqual(dealSafety(withinOnePct, OFFER), { ok: true }, "a cheaper offer within 1% does not block");
  const closed = { ...base, sessions: base.sessions.map((s) => (s.session_id === "s2" ? { ...s, status: "closed" } : s)) };
  assert.equal(dealSafety(closed, OFFER).ok, false, "a closed session's offer is not a deal");
  const expired = { ...base, sessions: base.sessions.map((s) => (s.session_id === "s2" ? { ...s, current_offer: { ...s.current_offer, expires_at: "2020-01-01T00:00:00Z" } } : s)) };
  assert.equal(dealSafety(expired, OFFER).ok, false, "an expired offer is not a deal");
});

test("DealNotifier: an injected READY line for a pricier offer sends nothing", async () => {
  const sent: EmailMessage[] = [];
  const transport = { async email(_from: unknown, m: EmailMessage) { sent.push(m); } } as unknown as Transport;
  const mcp = { async call() { return { ...order("me@example.com"), budget_cents: 50000 }; } } as unknown as McpToolClient;
  const n = new DealNotifier({ transport, mcpFor: async () => mcp });
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const ev = { id: "e1", kind: "offer.created" as const, payload: { session_id: "s1", request_id: "req-1" } };
  await n.afterTurn(buyer, ev, { action: "claude", summary: "READY TO RESERVE: other" } as never); // Mission 42500 vs Bay 37150
  assert.equal(sent.length, 0);
  await n.afterTurn(buyer, ev, { action: "ready", offerId: OFFER } as never);
  assert.equal(sent.length, 1, "the real cheapest deal still gets its email");
});

test("OrderNotifier: order.confirmed to the buyer sends one 'Order confirmed' email from the buyer agent", async () => {
  const sent: Array<{ from: string; m: EmailMessage }> = [];
  const transport = { async email(from: { id: string }, m: EmailMessage) { sent.push({ from: from.id, m }); } } as unknown as Transport;
  const calls: unknown[] = [];
  const mcp = { async call(name: string, args: unknown) { calls.push([name, args]); return order("me@example.com"); } } as unknown as McpToolClient;
  const n = new OrderNotifier({ transport, mcpFor: async () => mcp });
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const event = { id: "e9", kind: "order.confirmed" as const, created_at: "", route: { to_role: "buyer" as const, request_id: "req-1" }, payload: { order_id: "ord-1", request_id: "req-1", seller_name: "Bay Desk Co", total_cents: 37150, title: "Desk + ergonomic chair" } };
  await n.onOrder(buyer, event);
  await n.onOrder(buyer, event); // a redelivery does not send twice
  assert.deepEqual(calls, [["get_buy_order", { request_id: "req-1" }]]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, "buyer");
  assert.deepEqual([sent[0].m.to, sent[0].m.subject, sent[0].m.idempotencyKey], [["me@example.com"], "Order confirmed: Bay Desk Co, $371.50", "exchangent-order-ord-1"]);
  const quiet = new OrderNotifier({ transport, mcpFor: async () => ({ async call() { return order(null); } }) as unknown as McpToolClient });
  await quiet.onOrder(buyer, { ...event, payload: { ...event.payload, order_id: "ord-2" } });
  assert.equal(sent.length, 1, "no email on file: nothing sent");
});
