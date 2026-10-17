// Inkbox transport with the SDK mocked: no network, no keys. Signature checks use the real SDK verifyWebhook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyWebhook } from "@inkbox/sdk";
import { InkboxTransport, IdentityCapError, verifyInkboxSignature, WEBHOOK_PATH, eventParts } from "../src/transport/inkbox.ts";
import type { A2AEventParts, InkboxSdk } from "../src/transport/inkbox.ts";
import type { WorkerEvent } from "../src/backend.ts";
import type { TransportMessage } from "../src/transport/index.ts";
import { buyerAgent, sellerAgent } from "../src/agents.ts";
import { Mailbox } from "../src/mailbox.ts";

process.env.LOG_SILENT ??= "1";

// ---------------------------------------------------------------- signing helpers

function sign({ body, secret, requestId = randomUUID(), ts = Math.floor(Date.now() / 1000) }: { body: string; secret: string; requestId?: string; ts?: number }) {
  const key = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const sig = createHmac("sha256", key).update(`${requestId}.${ts}.${body}`).digest("hex");
  return { "x-inkbox-request-id": requestId, "x-inkbox-timestamp": String(ts), "x-inkbox-signature": `sha256=${sig}`, "content-type": "application/json" };
}

test("verifyInkboxSignature: valid, tampered, wrong key, stale, missing headers", () => {
  const secret = "whsec_testsecret";
  const body = JSON.stringify({ id: "evt_1", event_type: "a2a.task.created" });
  const headers = sign({ body, secret });
  const v = (o: Partial<Parameters<typeof verifyInkboxSignature>[0]>) => verifyInkboxSignature({ verify: verifyWebhook, secret, raw: Buffer.from(body), headers, ...o });

  assert.deepEqual(v({}), { ok: true });
  assert.equal(v({ secret: "testsecret" }).ok, true, "whsec_ prefix optional");
  assert.equal(v({ raw: Buffer.from(body.replace("evt_1", "evt_2")) }).reason, "signature mismatch");
  assert.equal(v({ secret: "whsec_other" }).reason, "signature mismatch");
  assert.equal(v({ nowMs: Date.now() + 301_000 }).reason, "timestamp outside 300s window");
  assert.equal(v({ headers: { ...headers, "x-inkbox-signature": "sha256=abc" } }).ok, false, "short digest does not throw");
  const { "x-inkbox-signature": _, ...noSig } = headers;
  assert.match(v({ headers: noSig }).reason!, /missing/);
  assert.match(v({ secret: undefined }).reason!, /no signing key/);
  // Header names are case-insensitive.
  const upper = Object.fromEntries(Object.entries(headers).map(([k, val]) => [k.toUpperCase(), val]));
  assert.equal(v({ headers: upper }).ok, true);
});

// ---------------------------------------------------------------- fake SDK

interface FakeIdentityRecord {
  id: string;
  handle: string;
  displayName?: string;
  description?: string;
}

interface SentMessage {
  from: string;
  to: string;
  messageId?: string;
  contextId?: string;
  parts: A2AEventParts;
  taskId: string;
}

interface FakeSubscription {
  id: string;
  agentIdentityId: string;
  url: string;
  eventTypes: string[];
}

type TunnelHandler = (req: Request, ctx: unknown) => Promise<Response>;

function makeFakeSdk({ planLimit = 3 }: { planLimit?: number } = {}) {
  const org = {
    identities: new Map<string, FakeIdentityRecord>(),
    keys: new Map<string, string>(),
    subs: [] as FakeSubscription[],
    signingKeys: new Map<string, string>(),
    tunnels: new Map<string, TunnelHandler>(),
    sent: [] as SentMessage[],
    replies: [] as Array<{ handle: string; taskId: string; intent: string; text?: string }>,
    enabled: new Set<string>(),
  };
  const calls = { createIdentity: [] as string[], apiKeys: [] as Array<{ label: string; scopedIdentityId: string }> };
  let n = 0;

  const apiError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

  class FakeIdentity {
    rec: FakeIdentityRecord;
    apiKey: string;
    constructor(rec: FakeIdentityRecord, apiKey: string) {
      this.rec = rec;
      this.apiKey = apiKey;
    }
    get id() { return this.rec.id; }
    get agentHandle() { return this.rec.handle; }
    get tunnel() { return { publicHost: `${this.rec.handle}.inkboxwire.com` }; }
    async a2aEnable() { org.enabled.add(this.rec.handle); return { enabled: true }; }
    async a2aReply(taskId: string, opts: { intent: string; text?: string }) { org.replies.push({ handle: this.rec.handle, taskId, ...opts }); return {}; }
    async *iterA2ATasks() {}
    async a2aClient() {
      const scoped = org.keys.get(this.apiKey);
      if (scoped !== this.rec.id) throw new Error("A2A calls require this claimed identity's agent-scoped API key");
      const fromHandle = this.rec.handle;
      return {
        fetchCard: async (url: string) => ({ url, handle: url.match(/\/a2a\/([^/]+)\/card$/)![1] }),
        send: async (target: { handle: string }, opts: { messageId?: string; contextId?: string; parts: A2AEventParts }) => {
          const contextId = opts.contextId || `ctx-${++n}`;
          const task = { id: `task-${++n}`, contextId, status: { state: "submitted" } };
          org.sent.push({ from: fromHandle, to: target.handle, ...opts, taskId: task.id });
          return { kind: "task", task };
        },
      };
    }
  }

  class Inkbox {
    apiKey: string;
    apiKeys: { create(o: { label: string; scopedIdentityId: string }): Promise<{ apiKey: string; record: { id: string; scopedIdentityId: string } }> };
    webhooks: {
      subscriptions: {
        list(o: { agentIdentityId: string; url: string }): Promise<FakeSubscription[]>;
        create(o: { agentIdentityId: string; url: string; eventTypes: string[] }): Promise<FakeSubscription & { signingKey: string | null }>;
      };
    };
    signingKeys: { createOrRotate(handle: string): Promise<{ signingKey: string; createdAt: Date }> };
    constructor({ apiKey }: { apiKey: string }) {
      this.apiKey = apiKey;
      this.apiKeys = {
        create: async ({ label, scopedIdentityId }) => {
          calls.apiKeys.push({ label, scopedIdentityId });
          const key = `agentkey-${scopedIdentityId}`;
          org.keys.set(key, scopedIdentityId);
          return { apiKey: key, record: { id: `k-${scopedIdentityId}`, scopedIdentityId } };
        },
      };
      this.webhooks = {
        subscriptions: {
          list: async ({ agentIdentityId, url }) => org.subs.filter((s) => s.agentIdentityId === agentIdentityId && s.url === url),
          create: async ({ agentIdentityId, url, eventTypes }) => {
            const first = !org.signingKeys.has(agentIdentityId);
            const sub = { id: `sub-${++n}`, agentIdentityId, url, eventTypes };
            org.subs.push(sub);
            let signingKey: string | null = null;
            if (first) {
              signingKey = `whsec_${randomUUID().replace(/-/g, "")}`;
              org.signingKeys.set(agentIdentityId, signingKey);
            }
            return { ...sub, signingKey };
          },
        },
      };
      this.signingKeys = {
        createOrRotate: async (handle) => {
          const rec = [...org.identities.values()].find((r) => r.handle === handle)!;
          const signingKey = `whsec_${randomUUID().replace(/-/g, "")}`;
          org.signingKeys.set(rec.id, signingKey);
          return { signingKey, createdAt: new Date() };
        },
      };
    }
    async createIdentity(handle: string, opts: { displayName?: string; description?: string }) {
      calls.createIdentity.push(handle);
      if ([...org.identities.values()].some((r) => r.handle === handle)) throw apiError(409, "handle taken");
      if (org.identities.size >= planLimit) throw apiError(402, "identity limit reached for plan");
      const rec = { id: `id-${++n}`, handle, ...opts };
      org.identities.set(rec.id, rec);
      return new FakeIdentity(rec, this.apiKey);
    }
    async getIdentity(handle: string) {
      const rec = [...org.identities.values()].find((r) => r.handle === handle);
      if (!rec) throw apiError(404, "not found");
      return new FakeIdentity(rec, this.apiKey);
    }
  }

  async function connect(_inkbox: unknown, { name, handler }: { name: string; handler: TunnelHandler }) {
    org.tunnels.set(name, handler);
    return { publicUrl: `https://${name}.inkboxwire.com`, close: async () => org.tunnels.delete(name), wait: async () => {} };
  }

  /** Act as Inkbox: deliver the last sent A2A message to the recipient's tunnel as a signed webhook. */
  async function deliver(sent: SentMessage, { webhookId = `evt_${randomUUID()}`, secretOverride }: { webhookId?: string; secretOverride?: string } = {}) {
    const target = [...org.identities.values()].find((r) => r.handle === sent.to);
    const body = JSON.stringify({
      id: webhookId,
      event_type: "a2a.task.created",
      timestamp: new Date().toISOString(),
      data: { task_id: sent.taskId, context_id: sent.contextId || "ctx", state: "submitted", caller: { identity_id: "x", organization_id: "org", handle: sent.from }, message_id: sent.messageId, parts: sent.parts },
    });
    const headers = sign({ body, secret: secretOverride || org.signingKeys.get(target!.id)! });
    const req = new Request(`https://${sent.to}.inkboxwire.com${WEBHOOK_PATH}`, { method: "POST", headers, body });
    return org.tunnels.get(sent.to)!(req, {});
  }

  // The fakes implement only the SDK surface InkboxTransport uses, not the full @inkbox/sdk classes.
  const sdk = { Inkbox, connect, verifyWebhook } as unknown as InkboxSdk;
  return { sdk, org, calls, deliver };
}

const market = {
  buyer: { actor_id: "buyer-1", token: "tok-buyer" },
  sellers: [
    { seller_id: "s-acme", name: "Acme Desks", token: "tok-acme" },
    { seller_id: "s-bay", name: "Bay Office", token: "tok-bay" },
  ],
};
const buyer = buyerAgent(market.buyer);
const acme = sellerAgent(market.sellers[0]);
const bay = sellerAgent(market.sellers[1]);

function opened(sellerId: string, sessionId: string = randomUUID()): WorkerEvent {
  return { id: randomUUID(), kind: "session.opened", created_at: new Date().toISOString(), payload: { session_id: sessionId, request_id: "req-1" }, route: { to_role: "seller", seller_id: sellerId } };
}

function makeTransport(opts: { cap?: number; planLimit?: number } = {}) {
  const fake = makeFakeSdk(opts);
  const registrations: Array<{ seller_id: string; agent_handle: string }> = [];
  const stateDir = mkdtempSync(path.join(tmpdir(), "agents-inkbox-"));
  const transport = new InkboxTransport({
    apiKey: "admin-key",
    identityCap: opts.cap ?? 3,
    stateDir,
    backend: { registerSellerAgent: async (seller_id: string, agent_handle: string) => registrations.push({ seller_id, agent_handle }) },
    sdk: fake.sdk,
  });
  return { transport, fake, registrations, stateDir };
}

// ---------------------------------------------------------------- tests

test("send: identities on demand, agent-scoped keys, registration, A2A message shape and context reuse", async () => {
  const { transport, fake, registrations, stateDir } = makeTransport();
  const ev1 = opened("s-acme", "sess-1");
  await transport.send(buyer, acme, ev1);

  assert.deepEqual(fake.calls.createIdentity, ["exchangent-buyer", "exchangent-acme-desks"]);
  assert.equal(fake.calls.apiKeys.length, 2, "one agent-scoped key per identity");
  assert.ok(fake.calls.apiKeys.every((k) => k.scopedIdentityId));
  assert.deepEqual([...fake.org.enabled].sort(), ["exchangent-acme-desks", "exchangent-buyer"]);
  assert.deepEqual(registrations, [{ seller_id: "s-acme", agent_handle: "exchangent-acme-desks" }], "only sellers are registered");
  assert.deepEqual(
    fake.org.subs.map((s) => [s.url, s.eventTypes.join(",")]),
    [
      ["https://exchangent-buyer.inkboxwire.com/inkbox/webhook", "a2a.task.created,a2a.task.message"],
      ["https://exchangent-acme-desks.inkboxwire.com/inkbox/webhook", "a2a.task.created,a2a.task.message"],
    ],
  );
  assert.ok(fake.org.tunnels.has("exchangent-buyer") && fake.org.tunnels.has("exchangent-acme-desks"), "tunnels online");

  const [s1] = fake.org.sent;
  assert.equal(s1.from, "exchangent-buyer", "sent from the counterparty's identity");
  assert.equal(s1.to, "exchangent-acme-desks");
  assert.equal(s1.messageId, ev1.id, "messageId = outbox event id");
  assert.equal(s1.contextId, undefined, "first message opens a new context");
  assert.deepEqual(s1.parts[0], { data: { kind: "session.opened", event_id: ev1.id, created_at: ev1.created_at, session_id: "sess-1", request_id: "req-1" } });
  assert.match(s1.parts[1].text, /^session\.opened session sess-1/);

  // A second event in the same session reuses the stored context; identities are not re-created.
  const offer: WorkerEvent = { id: randomUUID(), kind: "offer.created", created_at: new Date().toISOString(), payload: { session_id: "sess-1", request_id: "req-1", offer_id: "o-1", total_cents: 42000, note: "Bundle", budget_cents: 99999 }, route: { to_role: "buyer", seller_id: "s-acme" } };
  await transport.send(acme, buyer, offer);
  const s2 = fake.org.sent[1];
  assert.equal(s2.from, "exchangent-acme-desks");
  assert.equal(s2.contextId, transport.state.data.contexts["sess-1"]);
  assert.ok(s2.contextId);
  assert.equal(s2.parts[0].data.total_cents, 42000);
  assert.equal((s2.parts[0].data as Record<string, unknown>).budget_cents, undefined, "non-public fields are never forwarded");
  assert.equal(fake.calls.createIdentity.length, 2);

  // State persisted, owner-only.
  const file = path.join(stateDir, "identities.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.identities["seller:s-acme"].handle, "exchangent-acme-desks");
  assert.ok(saved.identities["seller:s-acme"].agent_api_key && saved.identities["seller:s-acme"].signing_key);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await transport.close();
});

test("receive: signed webhook -> mailbox once; duplicates, bad signatures and strangers are dropped; task acked", async () => {
  const { transport, fake } = makeTransport();
  const got: TransportMessage[] = [];
  const mailbox = new Mailbox(acme, async (_a, e) => got.push(e));
  transport.onMessage(acme, (m) => mailbox.push(m));

  const ev = opened("s-acme", "sess-9");
  await transport.send(buyer, acme, ev);
  const sent = fake.org.sent[0];

  const res = await fake.deliver(sent, { webhookId: "evt_A" });
  assert.equal(res.status, 200);
  await mailbox.idle();
  assert.deepEqual(got, [{ id: ev.id, kind: "session.opened", created_at: ev.created_at, from: "buyer", payload: { session_id: "sess-9", request_id: "req-1" } }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(fake.org.replies, [{ handle: "exchangent-acme-desks", taskId: sent.taskId, intent: "complete", text: "received" }]);

  // Same webhook id retried by Inkbox: ignored at the transport.
  assert.equal(await (await fake.deliver(sent, { webhookId: "evt_A" })).text(), "duplicate");
  // Different webhook id carrying the same outbox event (e.g. a re-send): the mailbox dedupes by event id.
  await fake.deliver(sent, { webhookId: "evt_B" });
  await mailbox.idle();
  assert.equal(got.length, 1);

  // Forged signature.
  const bad = await fake.deliver(sent, { webhookId: "evt_C", secretOverride: "whsec_forged" });
  assert.equal(bad.status, 401);

  // Valid signature but caller is not one of our identities.
  const stranger = { ...sent, from: "someone-else" };
  assert.equal(await (await fake.deliver(stranger, { webhookId: "evt_D" })).text(), "ignored");
  await mailbox.idle();
  assert.equal(got.length, 1);
  await transport.close();
});

test("identity cap: clear error before calling Inkbox once the configured cap is reached", async () => {
  const { transport, fake } = makeTransport({ cap: 2 });
  await transport.send(buyer, acme, opened("s-acme"));
  await assert.rejects(
    () => transport.send(buyer, bay, opened("s-bay")),
    (err) => {
      assert.ok(err instanceof IdentityCapError);
      assert.match(err.message, /identity cap reached \(2\/2: exchangent-buyer, exchangent-acme-desks\)/);
      assert.match(err.message, /Bay Office/);
      assert.match(err.message, /INKBOX_IDENTITY_CAP/);
      assert.match(err.message, /free plan allows 3/);
      return true;
    },
  );
  assert.equal(fake.calls.createIdentity.length, 2, "no third createIdentity call");
  await transport.close();
});

test("identity cap: Inkbox 402 (plan limit) becomes an IdentityCapError", async () => {
  const { transport, fake } = makeTransport({ cap: 10, planLimit: 2 });
  await transport.send(buyer, acme, opened("s-acme"));
  await assert.rejects(() => transport.send(buyer, bay, opened("s-bay")), (err) => err instanceof IdentityCapError && /HTTP 402/.test(err.message));
  assert.equal(fake.calls.createIdentity.length, 3);
  await transport.close();
});

test("handle collision: adopt our own identity when local state was lost", async () => {
  const first = makeTransport();
  await first.transport.send(buyer, acme, opened("s-acme"));
  await first.transport.close();
  // Same org (same fake), fresh state dir: createIdentity -> 409 -> getIdentity succeeds -> adopted.
  const stateDir = mkdtempSync(path.join(tmpdir(), "agents-inkbox-"));
  const second = new InkboxTransport({ apiKey: "admin-key", identityCap: 3, stateDir, backend: { registerSellerAgent: async () => {} }, sdk: first.fake.sdk });
  await second.send(buyer, acme, opened("s-acme"));
  assert.equal(second.identityFor("seller:s-acme")!.handle, "exchangent-acme-desks");
  assert.ok(second.identityFor("seller:s-acme")!.signing_key, "signing key rotated since the old one is unrecoverable");
  await second.close();
});

test("eventParts never includes notes in the data part and keeps the text short", () => {
  const parts = eventParts(acme, { id: "e1", kind: "offer.created", created_at: "t", payload: { session_id: "s", offer_id: "o", total_cents: 100, note: "x".repeat(500) } });
  assert.equal((parts[0].data as Record<string, unknown>).note, undefined);
  assert.ok(parts[1].text.length < 260);
});
