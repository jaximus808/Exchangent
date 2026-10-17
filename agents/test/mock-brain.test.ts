import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateAtTotal, decideBuyer, decideSeller, normalizeInventory, normalizeNegotiation, pickBundle } from "../src/brains/mock.ts";
import type { BuyOrder } from "../src/brains/mock.ts";
import { parseToolResult } from "../src/mcp.ts";
import { REQUIREMENTS, createMarket } from "./fakes.ts";

const inventory = normalizeInventory({ inventory: createMarket().sellers[0].inventory });

test("pickBundle honours max_width_in and ergonomic, picks cheapest qualifying", () => {
  assert.deepEqual(pickBundle(inventory, REQUIREMENTS)!.map((b) => b.inventoryId), ["acme-desk-46", "acme-chair"]);
  assert.equal(pickBundle(inventory, { items: [{ category: "desk", max_width_in: 30 }] }), null);
});

test("seller declines when no stock meets the requirements", () => {
  const neg = normalizeNegotiation({ status: "ok", session: { status: "open", turn: "seller", version: 0, requirements: { items: [{ category: "sofa" }] }, offers: [], counters: [] } });
  assert.equal(decideSeller(neg, inventory).action, "decline");
});

test("seller concession is clamped at floor and meets a counter at/above its minimum exactly", () => {
  const prev = { items: [{ inventory_id: "acme-desk-46", unit_cents: 18500 }, { inventory_id: "acme-chair", unit_cents: 10200 }] };
  const neg = normalizeNegotiation({ session: { status: "open", turn: "seller", version: 4, requirements: REQUIREMENTS, delivery_cents: 2000, offers: [{}, prev], counters: [{ total_cents: 29000 }] } });
  const move = decideSeller(neg, inventory);
  assert.equal(move.action, "offer");
  assert.deepEqual(move.lines.map((l) => l.unit_cents), [18000, 10000]);
  assert.equal(move.reason, "best price");

  neg.latestCounter = { total_cents: 31111 };
  const meet = decideSeller(neg, inventory);
  assert.equal(meet.action, "offer");
  assert.equal(meet.reason, "meets counter");
  assert.equal(meet.lines.reduce((s, l) => s + l.unit_cents * l.quantity, 0) + meet.deliveryCents, 31111);
});

test("allocateAtTotal: exact total, every line >= floor", () => {
  const bundle = pickBundle(inventory, REQUIREMENTS)!;
  for (const total of [28000, 28001, 33333, 40000]) {
    const lines = allocateAtTotal(bundle, total);
    assert.equal(lines.reduce((s, l) => s + l.unit_cents, 0), total);
    lines.forEach((l, i) => assert.ok(l.unit_cents >= bundle[i].floorCents));
  }
});

test("buyer: target first, split the difference, accept <= budget only after round 3", () => {
  const order = (rounds: number, offer: number, counter: number | null): BuyOrder => ({
    targetCents: 28000,
    budgetCents: 38000,
    sessions: [{ sessionId: "s", status: "open", turn: "buyer", version: 3, rounds, offer: { offerId: "o", totalCents: offer }, counter: counter ? { totalCents: counter } : null }],
  });
  assert.deepEqual([decideBuyer(order(0, 42000, null), "s").action, decideBuyer(order(0, 42000, null), "s").totalCents], ["counter", 28000]);
  assert.equal(decideBuyer(order(1, 40000, 28000), "s").totalCents, 34000);
  assert.equal(decideBuyer(order(2, 37000, 34000), "s").action, "counter", "within budget but before round 3: keep negotiating");
  assert.equal(decideBuyer(order(3, 37000, 35500), "s").action, "ready", "after round 3 anything within budget is acceptable");
  assert.equal(decideBuyer(order(1, 27500, 28000), "s").action, "ready", "at or under target");
  assert.equal(decideBuyer(order(5, 45000, 37900), "s").totalCents, 38000, "never counters above budget");
});

test("parseToolResult: structuredContent, JSON text, isError", () => {
  assert.deepEqual(parseToolResult({ structuredContent: { status: "ok", a: 1 } }), { status: "ok", a: 1 });
  assert.deepEqual(parseToolResult({ content: [{ type: "text", text: '{"status":"ok","b":2}' }] }), { status: "ok", b: 2 });
  assert.equal(parseToolResult({ isError: true, content: [{ type: "text", text: "boom" }] }).status, "error");
});

test("normalizeNegotiation does not confuse the tool status with the session status", () => {
  assert.equal(normalizeNegotiation({ status: "ok", session_id: "x", turn: "seller" }).status, "open");
  assert.equal(normalizeNegotiation({ status: "ok", session_status: "declined" }).status, "declined");
  assert.equal(normalizeNegotiation({ status: "ok", session: { status: "closed" } }).status, "closed");
});
