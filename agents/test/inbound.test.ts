import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buyerAgent, sellerAgent } from "../src/agents.ts";
import type { Agent } from "../src/agents.ts";
import { BackendError } from "../src/backend.ts";
import type { BuyerRequestStatus } from "../src/backend.ts";
import { InboundResponder, RATE_MAX, buyerStatusReply, isAutomated } from "../src/inbound.ts";
import type { EmailMessage } from "../src/notify.ts";
import type { InboundEmail, Transport } from "../src/transport/index.ts";

const buyer = buyerAgent({ actor_id: "agent", token: "bt", scope: "buyer_agent" });
const seller = sellerAgent({ seller_id: "s1", name: "Alex Woodworks", token: "st" });

function setup({ requests = {} as Record<string, BuyerRequestStatus[]>, lookup404 = false, owner = "alex@x.test" } = {}) {
  let clock = Date.parse("2026-10-18T10:00:00Z");
  const inbox = new Map<string, InboundEmail[]>([[buyer.id, []], [seller.id, []]]);
  const emails: { from: string; message: EmailMessage }[] = [];
  const read: string[] = [];
  const transport: Transport = {
    name: "fake-inkbox",
    async start() {},
    async send() { throw new Error("unused"); },
    onMessage() {},
    async email(from: Agent, message: EmailMessage) { emails.push({ from: from.id, message }); },
    hasMailbox: () => true,
    async inboundEmails(agent, since) { return (inbox.get(agent.id) || []).filter((m) => !since || m.createdAt >= since.toISOString()); },
    async markEmailsRead(_agent, ids) { read.push(...ids); },
    async ownEmailAddresses() { return ["exchangent-buyer@inkboxmail.com"]; },
    async close() {},
  };
  const lookups: string[] = [];
  const api = {
    async buyerRequestsByEmail(email: string) {
      lookups.push(email);
      if (lookup404) throw new BackendError(404, "not_found", "no route");
      return requests[email] || [];
    },
  };
  const mcpCalls: string[] = [];
  const mcpFor = async () => ({
    async call(name: string) {
      mcpCalls.push(name);
      if (name === "get_business") return { status: "ok", name: "Alex Woodworks", owner_email: owner } as never;
      if (name === "list_my_requests") return { status: "ok", sessions: [{ turn: "buyer", rounds: 2, status: "open", request: { title: "Desk + chair" }, current_offer: { total_cents: 30000 } }] } as never;
      return { status: "ok" } as never;
    },
  });
  const r = new InboundResponder({
    transport,
    registry: { all: () => [buyer, seller] },
    api,
    mcpFor,
    stateDir: mkdtempSync(path.join(tmpdir(), "exg-inbound-")),
    webUrl: "https://web.test",
    now: () => clock,
  });
  let n = 0;
  const deliver = (agent: Agent, from: string, subject = "How's my order?") => {
    clock += 1000;
    inbox.get(agent.id)!.push({ id: `m${++n}`, messageId: `<m${n}@mail>`, threadId: `t${n}`, from, subject, snippet: "", createdAt: new Date(clock).toISOString() });
  };
  return { r, emails, read, lookups, mcpCalls, deliver, tick: (ms: number) => (clock += ms) };
}

const REQ: BuyerRequestStatus = { request_id: "r1", title: "Desk + chair", status: "negotiating", best_offer: { seller_name: "Alex Woodworks", total_cents: 30000 }, sessions_open: 2, watch_path: "/watch/r1" };

test("first poll only sets the cursor: mail from before the runner started is never answered", async () => {
  const s = setup({ requests: { "bea@x.test": [REQ] } });
  s.deliver(buyer, "bea@x.test");
  assert.equal(await s.r.poll(), 0);
  assert.equal(s.emails.length, 0);
});

test("buyer agent: replies in-thread to the registered owner with live status and the watch link; read-only", async () => {
  const s = setup({ requests: { "bea@x.test": [REQ] } });
  await s.r.poll(); // cursor
  s.deliver(buyer, "Bea@X.test", "How's my desk order?");
  assert.equal(await s.r.poll(), 1);
  const { from, message } = s.emails[0];
  assert.equal(from, "buyer");
  assert.deepEqual(message.to, ["bea@x.test"], "the address that matched the account (lowercased), never a Reply-To");
  assert.equal(message.subject, "Re: How's my desk order?");
  assert.equal(message.inReplyToMessageId, "<m1@mail>");
  assert.match(message.text, /Alex Woodworks at \$300\.00/);
  assert.match(message.text, /https:\/\/web\.test\/watch\/r1/);
  assert.match(message.text, /never buy from an email/);
  assert.deepEqual(s.read, ["m1"]);
  assert.equal(await s.r.poll(), 0, "already handled");
});

test("unknown senders, our own identities and automated mail get no reply", async () => {
  const s = setup({ requests: {} });
  await s.r.poll();
  s.deliver(buyer, "stranger@x.test");
  s.deliver(buyer, "exchangent-buyer@inkboxmail.com");
  s.deliver(buyer, "mailer-daemon@x.test", "Undeliverable: hi");
  s.deliver(buyer, "bea@x.test", "Automatic reply: out of office");
  assert.equal(await s.r.poll(), 0);
  assert.equal(s.emails.length, 0);
  assert.deepEqual(s.lookups, ["stranger@x.test"], "only the human mail is looked up");
  assert.ok(isAutomated({ from: "x@y", subject: "Out of Office: back Monday" }));
});

test("rate limit: at most RATE_MAX replies per sender per hour", async () => {
  const s = setup({ requests: { "bea@x.test": [REQ] } });
  await s.r.poll();
  for (let i = 0; i < RATE_MAX + 3; i++) s.deliver(buyer, "bea@x.test");
  assert.equal(await s.r.poll(), RATE_MAX);
  s.tick(61 * 60_000);
  s.deliver(buyer, "bea@x.test");
  assert.equal(await s.r.poll(), 1, "a new hour, a new allowance");
});

test("old backend without /worker/buyer-requests: quiet, no reply, no crash", async () => {
  const s = setup({ lookup404: true });
  await s.r.poll();
  s.deliver(buyer, "bea@x.test");
  s.deliver(buyer, "bea@x.test");
  assert.equal(await s.r.poll(), 0);
  assert.equal(s.lookups.length, 1, "stops looking up after the first 404");
});

test("seller agent: only the business owner gets the negotiations summary", async () => {
  const s = setup();
  await s.r.poll();
  s.deliver(seller, "someone@else.test");
  s.deliver(seller, "ALEX@x.test", "status?");
  assert.equal(await s.r.poll(), 1);
  assert.equal(s.emails.length, 1);
  assert.equal(s.emails[0].from, "seller:s1");
  assert.deepEqual(s.emails[0].message.to, ["alex@x.test"]);
  assert.match(s.emails[0].message.text, /Desk \+ chair: buyer's move, round 2, our offer \$300\.00/);
});

test("buyerStatusReply: no requests -> a plain sentence, HTML escaped", () => {
  const r = buyerStatusReply([{ ...REQ, title: "<b>x</b>" }], "https://w");
  assert.match(r.html, /&#60;b&#62;x/);
  assert.match(buyerStatusReply([], "https://w").text, /no open orders/);
});
