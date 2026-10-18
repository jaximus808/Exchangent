import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/agents.ts";
import type { Agent } from "../src/agents.ts";
import type { WorkerEvent } from "../src/backend.ts";
import { Dispatcher, transcriptLine } from "../src/dispatcher.ts";
import { localReceipt } from "../src/transport/index.ts";
import type { DeliveryReceipt, MessageHandler, Transport } from "../src/transport/index.ts";

const BUYER = "11111111-1111-4111-8111-111111111111";
const PERSON = "22222222-2222-4222-8222-222222222222";
const SELLER = "33333333-3333-4333-8333-333333333333";

function setup(events: WorkerEvent[], since: Date | null = null, scope: "buyer" | "buyer_agent" = "buyer") {
  const registry = new AgentRegistry({
    buyer: { actor_id: BUYER, token: "b", scope },
    sellers: [{ seller_id: SELLER, name: "Bay Desk Co", token: "s" }],
    worker: { token: "w" },
  });
  const acked: string[] = [];
  const receipts: Record<string, DeliveryReceipt | undefined> = {};
  const sent: { from: string | null; to: string; id: string }[] = [];
  const transport: Transport = {
    name: "fake",
    async start() {},
    onMessage(_agent: Agent, _handler: MessageHandler) {},
    async send(from, to, event) {
      sent.push({ from: from?.id ?? null, to: to.id, id: event.id });
      return localReceipt(from, to, event);
    },
    async email() {},
    async close() {},
  };
  const api = {
    async events() {
      return events.filter((e) => !acked.includes(e.id));
    },
    async ack(id: string, delivery?: DeliveryReceipt) {
      acked.push(id);
      receipts[id] = delivery;
      return {};
    },
  };
  return { dispatcher: new Dispatcher({ api, transport, registry, since }), acked, sent, receipts };
}

const event = (id: string, kind: WorkerEvent["kind"], to_role: "buyer" | "seller", buyer_id: string, created_at = new Date().toISOString(), delegated?: boolean): WorkerEvent => ({
  id,
  kind,
  created_at,
  payload: { session_id: `session-${buyer_id}` },
  route: { to_role, seller_id: SELLER, buyer_id, ...(delegated === undefined ? {} : { delegated }) },
});

test("a person's order: sellers still get events (no sender), buyer-bound events are acked without delivery", async () => {
  const { dispatcher, acked, sent } = setup([
    event("e1", "session.opened", "seller", PERSON),
    event("e2", "offer.created", "buyer", PERSON),
    event("e3", "session.opened", "seller", BUYER),
    event("e4", "offer.created", "buyer", BUYER),
  ]);
  assert.equal(await dispatcher.tick(), 3);
  assert.deepEqual(sent, [
    { from: null, to: `seller:${SELLER}`, id: "e1" },
    { from: "buyer", to: `seller:${SELLER}`, id: "e3" },
    { from: `seller:${SELLER}`, to: "buyer", id: "e4" },
  ]);
  assert.deepEqual(acked, ["e1", "e2", "e3", "e4"]);
});

test("SKIP_BACKLOG: events from before the runner started are acked, not delivered", async () => {
  const start = new Date();
  const { dispatcher, acked, sent } = setup(
    [event("old", "session.opened", "seller", BUYER, new Date(start.getTime() - 60_000).toISOString()), event("new", "session.opened", "seller", BUYER)],
    start,
  );
  assert.equal(await dispatcher.tick(), 1);
  assert.deepEqual(sent.map((s) => s.id), ["new"]);
  assert.deepEqual(acked, ["old", "new"]);
});

test("platform buyer agent (buyer_agent token): negotiates every delegated order, skips the rest", async () => {
  const now = new Date().toISOString();
  const { dispatcher, acked, sent } = setup(
    [
      event("d1", "session.opened", "seller", PERSON, now, true),
      event("d2", "offer.created", "buyer", PERSON, now, true),
      event("n1", "session.opened", "seller", BUYER, now, false),
      event("n2", "offer.created", "buyer", BUYER, now, false),
    ],
    null,
    "buyer_agent",
  );
  assert.equal(await dispatcher.tick(), 3);
  assert.deepEqual(sent, [
    { from: "buyer", to: `seller:${SELLER}`, id: "d1" },
    { from: `seller:${SELLER}`, to: "buyer", id: "d2" },
    { from: null, to: `seller:${SELLER}`, id: "n1" },
  ]);
  assert.deepEqual(acked, ["d1", "d2", "n1", "n2"]);
});

test("acks carry the delivery receipt; skipped and backlog acks carry none", async () => {
  const start = new Date();
  const { dispatcher, acked, receipts } = setup(
    [
      event("old", "session.opened", "seller", BUYER, new Date(start.getTime() - 60_000).toISOString()),
      event("skip", "offer.created", "buyer", PERSON),
      event("sent", "session.opened", "seller", BUYER),
    ],
    start,
  );
  await dispatcher.tick();
  assert.deepEqual(acked, ["old", "skip", "sent"]);
  assert.equal(receipts.old, undefined);
  assert.equal(receipts.skip, undefined);
  assert.deepEqual({ ...receipts.sent, delivered_at: "t" }, { transport: "local", from_handle: "buyer", to_handle: "bay-desk-co", message_id: "sent", delivered_at: "t" });
});

test("transcriptLine: who said what, from the payload, with the hop", () => {
  const registry = new AgentRegistry({
    buyer: { actor_id: BUYER, token: "b", scope: "buyer_agent" },
    sellers: [{ seller_id: SELLER, name: "Alex Woodworks", token: "s" }],
    worker: { token: "w" },
  });
  const [buyer, seller] = [registry.buyer, registry.seller(SELLER)!];
  const offer: WorkerEvent = { id: "e1", kind: "offer.created", created_at: "", payload: { session_id: "s", total_cents: 30000, note: " Deal at $300. " }, route: { to_role: "buyer" } };
  const hop: DeliveryReceipt = { transport: "inkbox", from_handle: "exchangent-alex-woodworks", to_handle: "exchangent-buyer", message_id: "e1", delivered_at: "" };
  assert.equal(transcriptLine(seller, buyer, offer, hop), '💬 Alex Woodworks agent → Buyer agent: $300.00 "Deal at $300." [inkbox exchangent-alex-woodworks → exchangent-buyer]');
  const counter: WorkerEvent = { ...offer, kind: "counter.created", payload: { session_id: "s", total_cents: 28000 } };
  assert.equal(transcriptLine(buyer, seller, counter), "💬 Buyer agent → Alex Woodworks agent: $280.00");
  assert.equal(transcriptLine(null, buyer, { ...offer, kind: "session.declined", payload: { session_id: "s" } }), "💬 Seller (in chat) → Buyer agent: declined");
  assert.equal(transcriptLine(buyer, seller, { ...offer, kind: "session.opened" }), null);
});
