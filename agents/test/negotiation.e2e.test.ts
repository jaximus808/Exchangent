// Full loop with TRANSPORT=local BRAIN=mock against a fake backend (worker HTTP) and a fake MCP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRunner } from "../src/runner.ts";
import { onLog } from "../src/log.ts";
import type { LogRecord } from "../src/log.ts";
import type { Config } from "../src/config.ts";
import type { MockBrain } from "../src/brains/mock.ts";
import { createMarket, startFakeBackend, startFakeMcp, waitFor, REQUIREMENTS } from "./fakes.ts";
import type { OfferItem } from "./fakes.ts";

process.env.LOG_SILENT ??= "1";

test("local transport + mock brain negotiate to 'ready to reserve'", async (t) => {
  // tamperTotals: outbox payloads carry total_cents=1. The brains must ignore message numbers and re-read via MCP.
  const market = createMarket({ tamperTotals: true });
  const backend = await startFakeBackend(market);
  const mcp = await startFakeMcp(market);
  const logs: LogRecord[] = [];
  const unsub = onLog((r) => logs.push(r));

  const requestId = market.createBuyOrder({
    title: "Desk + ergonomic chair",
    requirements: REQUIREMENTS,
    budget_cents: 38000,
    target_cents: 28000,
  });
  // At-least-once: the first ack fails, so the dispatcher redelivers that event; the mailbox must dedupe it.
  const firstEventId = market.outbox[0].id;
  market.failAckOnce(firstEventId);

  const config: Config = {
    transport: "local",
    brain: "mock",
    backendUrl: backend.url,
    mcpUrl: mcp.url,
    pollMs: 10,
    skipBacklog: false,
    principals: market.principalsJson(backend.url),
    principalsFile: "/nonexistent",
    stateDir: mkdtempSync(path.join(tmpdir(), "agents-e2e-")),
    inkbox: {},
    claude: {},
  };
  const runner = await createRunner(config);
  t.after(async () => {
    unsub();
    await runner.stop();
    await mcp.close();
    await backend.close();
  });
  await runner.start();
  const brain = runner.brain as MockBrain; // BRAIN=mock

  await waitFor(() => brain.ready.has(requestId), 15000);
  // Let any in-flight turns for the other seller finish, then stop.
  await waitFor(async () => {
    await runner.idle();
    return true;
  });

  const acme = [...market.sessions.values()].find((s) => s.seller_id === "s-acme")!;
  const timeline: Array<{ who: string; total: number; at: number; items?: OfferItem[] }> = [
    ...[...market.offers.values()].filter((o) => o.session_id === acme.session_id).map((o) => ({ who: "seller", total: o.total_cents, at: o.version, items: o.items })),
    ...[...market.counters.values()].filter((c) => c.session_id === acme.session_id).map((c) => ({ who: "buyer", total: c.total_cents, at: c.version })),
  ].sort((a, b) => a.at - b.at);

  // session.opened -> list (desk 25000 + ergonomic chair 15000 + delivery 2000), buyer counters at target,
  // seller concedes 5% per item, buyer splits the difference. The counter clears the floor minimum (30000), but
  // before round 3 the seller only meets halfway (doc/hardening-contract.md); at round 3 that is within budget.
  assert.deepEqual(
    timeline.map((x) => [x.who, x.total]),
    [
      ["seller", 42000],
      ["buyer", 28000],
      ["seller", 40000],
      ["buyer", 34000],
      ["seller", 37000],
    ],
  );
  // Requirements respected: the 46in desk (not the cheaper 60in) and the ergonomic chair (not the stool).
  assert.deepEqual(timeline[0].items!.map((i) => i.inventory_id).sort(), ["acme-chair", "acme-desk-46"]);
  // Never below floor.
  for (const o of market.offers.values()) {
    for (const it of o.items) {
      const row = market.sellers.flatMap((s) => s.inventory).find((r) => r.inventory_id === it.inventory_id)!;
      assert.ok(it.unit_cents >= row.floor_cents, `${it.inventory_id} below floor`);
    }
  }

  const ready = brain.ready.get(requestId)!;
  const finalOffer = market.offers.get(ready.offerId!)!;
  assert.equal(finalOffer.session_id, acme.session_id);
  assert.equal(finalOffer.total_cents, 37000);
  assert.ok(logs.some((l) => l.msg === `READY TO RESERVE: offer ${ready.offerId}`), "ready log line");

  // The Bay Office session (floors above budget) never became acceptable.
  const bay = [...market.sessions.values()].find((s) => s.seller_id === "s-bay")!;
  assert.ok([...market.offers.values()].filter((o) => o.session_id === bay.session_id).every((o) => o.total_cents > 38000));

  // Every turn re-read state through MCP with the agent's own bearer token.
  assert.ok(mcp.authHeaders.every((h) => /^Bearer tok-(buyer|acme|bay)$/.test(h)));
  const buyerCalls = market.toolCalls.filter((c) => c.scope === "buyer").map((c) => c.name);
  const sellerCalls = market.toolCalls.filter((c) => c.scope === "seller").map((c) => c.name);
  assert.ok(buyerCalls.includes("get_buy_order") && buyerCalls.includes("counter_offer"));
  assert.ok(!buyerCalls.some((n) => ["reserve_offer", "get_checkout_link"].includes(n)), "buyer agent never reserves");
  assert.ok(sellerCalls.includes("get_negotiation") && sellerCalls.includes("get_inventory") && sellerCalls.includes("make_offer"));
  assert.equal(market.toolCalls.filter((c) => c.scope === undefined).length, 0);

  // At-least-once: the event whose first ack failed was delivered twice but processed once.
  assert.ok(logs.some((l) => l.msg === "duplicate skipped" && l.event === firstEventId), "duplicate delivery deduped");
  assert.equal(runner.turns.filter((x) => x.eventId === firstEventId).length, 1);
  assert.ok(market.acks.includes(firstEventId));

  // Local transport never registers Inkbox handles.
  assert.equal(market.registrations.length, 0);
});

test("self-serve business: dynamic seller agent negotiates and wins, then its owner gets the sale email", async (t) => {
  const market = createMarket({ selfServe: true });
  const backend = await startFakeBackend(market);
  const mcp = await startFakeMcp(market);
  const logs: LogRecord[] = [];
  const unsub = onLog((r) => logs.push(r));
  const requestId = market.createBuyOrder({ title: "Desk + ergonomic chair", requirements: REQUIREMENTS, budget_cents: 38000, target_cents: 28000 });
  const config: Config = {
    transport: "local",
    brain: "mock",
    backendUrl: backend.url,
    mcpUrl: mcp.url,
    pollMs: 10,
    skipBacklog: false,
    principals: market.principalsJson(backend.url),
    principalsFile: "/nonexistent",
    stateDir: mkdtempSync(path.join(tmpdir(), "agents-e2e-")),
    inkbox: {},
    claude: {},
  };
  assert.ok(!config.principals.sellers.some((s) => s.seller_id === "s-jaxon"), "the business is not in the principals file");
  const runner = await createRunner(config);
  t.after(async () => {
    unsub();
    await runner.stop();
    await mcp.close();
    await backend.close();
  });
  await runner.start();
  const brain = runner.brain as MockBrain;
  await waitFor(() => brain.ready.has(requestId), 15000);
  await runner.idle();

  // The owner's floors (16000 + 9000 + 1000 delivery) are under the buyer's $280 target, but its agent does not
  // give the floor away on the first counter: it meets the buyer partway and settles within budget.
  const ready = brain.ready.get(requestId)!;
  const offer = market.offers.get(ready.offerId!)!;
  assert.equal(market.sessions.get(offer.session_id)!.seller_id, "s-jaxon");
  assert.equal(offer.total_cents, 31375);
  assert.ok(market.toolCalls.some((c) => c.token === "tok-jaxon" && c.name === "make_offer"), "the dynamic agent used its minted token");
  assert.equal(runner.registry.seller("s-jaxon")!.dynamic, true);

  // The buyer pays: order.confirmed -> one "Sold" email to the owner, no brain turn.
  const turnsBefore = runner.turns.length;
  const orderId = market.confirmOrder(ready.offerId!);
  await waitFor(() => logs.some((l) => l.msg === "sale email sent"), 5000);
  const sent = logs.find((l) => l.msg === "sale email sent")!;
  assert.equal(sent.from, "seller:s-jaxon");
  assert.ok(logs.some((l) => l.msg === "email (local transport: not sent)" && l.subject === "Sold: Desk + ergonomic chair, $313.75"));
  assert.ok(market.acks.includes(market.outbox.find((e) => e.kind === "order.confirmed" && e.payload.order_id === orderId)!.id));
  assert.equal(runner.turns.length, turnsBefore, "order.confirmed never runs a brain turn");
  assert.deepEqual(market.mints, ["s-jaxon"], "minted once, reused for the notice");
});
