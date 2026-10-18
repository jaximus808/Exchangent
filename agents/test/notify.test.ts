import test from "node:test";
import assert from "node:assert/strict";
import { buyerAgent, sellerAgent } from "../src/agents.ts";
import { DealNotifier, dealEmail, dealFromOrder, readyOfferId } from "../src/notify.ts";
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
  const mcp = { async call() { return withLate; } } as unknown as McpToolClient;
  const n = new DealNotifier({ transport, mcpFor: async () => mcp });
  const buyer = buyerAgent({ actor_id: "a", token: "t", scope: "buyer_agent" });
  const ev = { id: "e1", kind: "offer.created" as const, payload: { session_id: "s2", request_id: "req-1" } };
  await n.afterTurn(buyer, ev, { action: "ready", offerId: OFFER } as never);
  await n.afterTurn(buyer, ev, { action: "ready", offerId: LATE } as never);
  await n.afterTurn(buyer, ev, { action: "ready", offerId: LATE } as never);
  assert.deepEqual(sent.map((m) => [m.subject, m.idempotencyKey]), [
    ["Deal reached: Bay Desk Co, $371.50", "exchangent-deal-req-1"],
    ["Better deal: Alex Woodworks, $300.00", `exchangent-deal-req-1-${LATE}`],
  ]);
});
