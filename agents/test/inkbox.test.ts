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

interface FakeTask {
  id: string;
  contextId: string;
  state: string;
  caller: { identityId: string; organizationId: string; handle: string; trustTier: string };
  messages: Array<{ id: string; messageId: string; role: string; parts: Record<string, unknown>[] }>;
}

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
    /** receiver inbox per handle (a2aTasks / a2aTask) */
    inbox: new Map<string, FakeTask[]>(),
    /** tunnels whose serveForever() was called (connect() alone does not open the data plane) */
    serving: new Set<string>(),
  };
  const calls = { createIdentity: [] as string[], apiKeys: [] as Array<{ label: string; scopedIdentityId: string }>, cardUrls: [] as string[], emails: [] as Array<{ from: string; to: string[]; subject: string; idempotencyKey?: string }> };
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
    // A2ASettings (camelCase, parsed by the SDK); cardUrl is the canonical card URL.
    async a2aEnable() {
      org.enabled.add(this.rec.handle);
      return { enabled: true, publiclyDiscoverable: false, allowPublicEgress: true, filterMode: "whitelist", skills: null, cardUrl: `https://inkbox.ai/a2a/${this.rec.handle}/card`, inboundTaskCount: 0, outboundTaskCount: 0, updatedAt: null };
    }
    async sendEmail(opts: { to: string[]; subject: string; bodyText?: string; bodyHtml?: string; idempotencyKey?: string }) {
      calls.emails.push({ from: this.rec.handle, to: opts.to, subject: opts.subject, idempotencyKey: opts.idempotencyKey });
      return { id: `msg_${calls.emails.length}` };
    }
    async a2aReply(taskId: string, opts: { intent: string; text?: string; parts?: unknown[] }) {
      if ((opts.text === undefined) === (opts.parts === undefined)) throw new TypeError("Pass exactly one of text or parts");
      org.replies.push({ handle: this.rec.handle, taskId, ...opts });
      const task = (org.inbox.get(this.rec.handle) || []).find((t) => t.id === taskId);
      if (task) task.state = opts.intent === "complete" ? "completed" : task.state;
      return task;
    }
    async *iterA2ATasks({ state }: { state?: string } = {}) {
      for (const t of org.inbox.get(this.rec.handle) || []) if (!state || t.state === state) yield t;
    }
    async a2aTask(taskId: string) {
      const task = (org.inbox.get(this.rec.handle) || []).find((t) => t.id === taskId);
      if (!task) throw apiError(404, "task not found");
      return task;
    }
    async a2aClient() {
      // The real SDK checks whoami: authSubtype "api_key.agent_scoped.claimed" and scope "agent_identity:<id>".
      const scoped = org.keys.get(this.apiKey);
      if (scoped !== this.rec.id) throw new Error("A2A calls require this claimed identity's agent-scoped API key");
      const fromHandle = this.rec.handle;
      const fromId = this.rec.id;
      return {
        // A2AResolvedTarget: { cardUrl, rpcUrl, protocolVersion, card }
        fetchCard: async (cardUrl: string) => {
          calls.cardUrls.push(cardUrl);
          const handle = cardUrl.match(/^https:\/\/inkbox\.ai\/a2a\/([^/]+)\/card$/)![1];
          const rpcUrl = `https://inkbox.ai/a2a/${handle}`;
          return { cardUrl, rpcUrl, protocolVersion: "1.0", card: { name: `@${handle}`, supportedInterfaces: [{ url: rpcUrl, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] } };
        },
        // A2ASendResult: { kind: "task", task: A2AWireTask } (Inkbox workers always return a task)
        send: async (target: { rpcUrl: string }, opts: { messageId?: string; contextId?: string; parts: A2AEventParts }) => {
          const to = target.rpcUrl.split("/").pop()!;
          const contextId = opts.contextId || `ctx-${++n}`;
          const task = { id: `task-${++n}`, contextId, status: { state: "TASK_STATE_SUBMITTED" } };
          org.sent.push({ from: fromHandle, to, ...opts, taskId: task.id });
          const inbox = org.inbox.get(to) || [];
          inbox.push({ id: task.id, contextId, state: "submitted", caller: { identityId: fromId, organizationId: "org", handle: fromHandle, trustTier: "organization" }, messages: [{ id: `m-${n}`, messageId: opts.messageId || "", role: "caller", parts: opts.parts }] });
          org.inbox.set(to, inbox);
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
        list(o: { agentIdentityId: string; url: string; scope?: "identity" }): Promise<FakeSubscription[]>;
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

  // Like the real connect(): bootstrap only. The tunnel receives traffic once serveForever() runs, which reports
  // "connecting" then "connected" through onStatus and resolves on close().
  async function connect(_inkbox: unknown, { name, handler, onStatus }: { name: string; handler: TunnelHandler; onStatus?: (s: string) => void }) {
    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => { stop = resolve; });
    let status = "idle";
    const setStatus = (s: string) => { status = s; onStatus?.(s); };
    const listener = {
      publicUrl: `https://${name}.inkboxwire.com`,
      get status() { return status; },
      get isConnected() { return status === "connected"; },
      serveForever: async () => {
        setStatus("connecting");
        org.serving.add(name);
        org.tunnels.set(name, handler);
        setStatus("connected");
        await stopped;
      },
      wait: async () => listener.serveForever(),
      close: async () => { org.tunnels.delete(name); org.serving.delete(name); setStatus("closed"); stop(); },
    };
    return listener;
  }

  /** Act as Inkbox: deliver the last sent A2A message to the recipient's tunnel as a signed webhook. */
  async function deliver(sent: SentMessage, { webhookId = `evt_${randomUUID()}`, secretOverride }: { webhookId?: string; secretOverride?: string } = {}) {
    const target = [...org.identities.values()].find((r) => r.handle === sent.to);
    const body = JSON.stringify({
      id: webhookId,
      event_type: "a2a.task.created",
      timestamp: new Date().toISOString(),
      data: {
        task_id: sent.taskId,
        context_id: sent.contextId || "ctx",
        state: "submitted",
        caller: { identity_id: "x", organization_id: "org", handle: sent.from },
        sender: { identity_id: "x", organization_id: "org", handle: sent.from },
        message_id: sent.messageId,
        parts: sent.parts,
      },
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
  assert.deepEqual([...fake.org.serving].sort(), ["exchangent-acme-desks", "exchangent-buyer"], "serveForever() started for each tunnel");
  assert.deepEqual(fake.calls.cardUrls, ["https://inkbox.ai/a2a/exchangent-acme-desks/card"], "card URL from the A2A settings");

  const [s1] = fake.org.sent;
  assert.equal(s1.from, "exchangent-buyer", "sent from the counterparty's identity");
  assert.equal(s1.to, "exchangent-acme-desks");
  assert.equal(s1.messageId, ev1.id, "messageId = outbox event id");
  assert.equal(s1.contextId, undefined, "first message opens a new context");
  assert.deepEqual(s1.parts[0], { data: { kind: "session.opened", event_id: ev1.id, created_at: ev1.created_at, session_id: "sess-1", request_id: "req-1" } });
  assert.match(s1.parts[1].text, /^session\.opened session sess-1/);

  // A second event in the same session reuses the stored context; identities are not re-created.
  const offer: WorkerEvent = { id: randomUUID(), kind: "offer.created", created_at: new Date().toISOString(), payload: { session_id: "sess-1", request_id: "req-1", offer_id: "o-1", total_cents: 42000, note: "Bundle", budget_cents: 99999 }, route: { to_role: "buyer", seller_id: "s-acme" } };
  const receipt = await transport.send(acme, buyer, offer);
  const s2 = fake.org.sent[1];
  assert.deepEqual({ ...receipt, delivered_at: "t" }, {
    transport: "inkbox", from_handle: "exchangent-acme-desks", to_handle: "exchangent-buyer",
    message_id: offer.id, context_id: transport.state.data.contexts["sess-1"], delivered_at: "t",
  }, "receipt names the identities, the message and the A2A context");
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

test("identity cap: ensureIdentity explains the cap without calling Inkbox; send falls back to in-process", async () => {
  const { transport, fake } = makeTransport({ cap: 2 });
  await transport.send(buyer, acme, opened("s-acme"));
  await assert.rejects(
    () => transport.ensureIdentity(bay),
    (err) => {
      assert.ok(err instanceof IdentityCapError);
      assert.match(err.message, /identity cap reached \(2\/2: exchangent-buyer, exchangent-acme-desks\)/);
      assert.match(err.message, /Bay Office/);
      assert.match(err.message, /INKBOX_IDENTITY_CAP/);
      assert.match(err.message, /free plan allows 3/);
      return true;
    },
  );
  // send() does not fail the event: Bay Office is delivered in-process, from the buyer agent.
  const got: TransportMessage[] = [];
  transport.onMessage(bay, (m) => got.push(m));
  const ev = opened("s-bay");
  const receipt = await transport.send(buyer, bay, ev);
  assert.deepEqual(got.map((m) => [m.id, m.from]), [[ev.id, "buyer"]]);
  assert.deepEqual([receipt.transport, receipt.from_handle, receipt.to_handle, receipt.message_id], ["local", "buyer", bay.slug, ev.id], "in-process receipt");
  assert.equal(transport.isLocal(bay), true);
  assert.equal(transport.hasMailbox(bay), false);
  // ...and Bay's replies reach the buyer in-process too (no A2A from an identity Bay doesn't have).
  const toBuyer: TransportMessage[] = [];
  transport.onMessage(buyer, (m) => toBuyer.push(m));
  const offer: WorkerEvent = { id: randomUUID(), kind: "offer.created", created_at: new Date().toISOString(), payload: { session_id: ev.payload.session_id!, offer_id: "o1", total_cents: 100 }, route: { to_role: "buyer", seller_id: "s-bay" } };
  await transport.send(bay, buyer, offer);
  assert.deepEqual(toBuyer.map((m) => [m.id, m.from]), [[offer.id, "seller:s-bay"]]);
  assert.equal(fake.calls.createIdentity.length, 2, "no third createIdentity call");
  assert.equal(fake.org.sent.length, 1, "only the first event went over A2A");
  await transport.close();
});

test("identity cap: Inkbox 402 (plan limit) falls back to in-process delivery", async () => {
  const { transport, fake } = makeTransport({ cap: 10, planLimit: 2 });
  await transport.send(buyer, acme, opened("s-acme"));
  const got: string[] = [];
  transport.onMessage(bay, (m) => got.push(m.id));
  const ev = opened("s-bay");
  await transport.send(buyer, bay, ev);
  assert.deepEqual(got, [ev.id]);
  assert.equal(fake.calls.createIdentity.length, 3);
  // Later events fail fast: no more createIdentity calls once Inkbox said 402.
  await transport.send(buyer, bay, opened("s-bay"));
  assert.equal(fake.calls.createIdentity.length, 3);
  await assert.rejects(() => transport.ensureIdentity(bay), (err) => err instanceof IdentityCapError && /HTTP 402/.test(err.message));
  await transport.close();
});

test("INKBOX_LOCAL_SELLERS: listed sellers never get an identity (by name or id, any case)", async () => {
  const fake = makeFakeSdk({});
  const stateDir = mkdtempSync(path.join(tmpdir(), "agents-inkbox-"));
  const transport = new InkboxTransport({ apiKey: "admin-key", identityCap: 3, stateDir, localSellers: ["BAY OFFICE", "s-other"], backend: { registerSellerAgent: async () => {} }, sdk: fake.sdk });
  const got: string[] = [];
  transport.onMessage(bay, (m) => got.push(m.id));
  const ev = opened("s-bay");
  await transport.send(buyer, bay, ev);
  assert.deepEqual(got, [ev.id]);
  assert.deepEqual(fake.calls.createIdentity, ["exchangent-buyer"]);
  assert.equal(transport.isLocal(bay), true);
  assert.equal(transport.isLocal(acme), false);
  assert.equal(transport.isLocal(buyer), false, "only sellers can be listed");
  await assert.rejects(() => transport.email(bay, { to: ["o@example.com"], subject: "s", text: "t", html: "h", idempotencyKey: "k" }), IdentityCapError);
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

test("no sender (a person's order): seller gets the event in-process, Inkbox is never called", async () => {
  const { transport, fake } = makeTransport();
  const got: string[] = [];
  transport.onMessage(acme, (m) => got.push(m.id));
  const ev = opened("s-acme");
  await transport.send(null, acme, ev);
  assert.deepEqual(got, [ev.id]);
  assert.deepEqual(fake.calls.createIdentity, []);
  assert.equal(fake.org.sent.length, 0);
  // A seller negotiating in chat (no seller agent) reaches the buyer agent in-process as well.
  const toBuyer: string[] = [];
  transport.onMessage(buyer, (m) => toBuyer.push(m.id));
  await transport.send(null, buyer, ev);
  assert.deepEqual(toBuyer, [ev.id]);
  assert.equal(fake.org.sent.length, 0);
});

test("restart: tasks still submitted in the inbox are replayed to the agent and completed", async () => {
  const first = makeTransport();
  const ev = opened("s-acme", "sess-r");
  await first.transport.send(buyer, acme, ev); // nobody delivers the webhook: the task stays "submitted"
  await first.transport.close();

  const second = new InkboxTransport({ apiKey: "admin-key", identityCap: 3, stateDir: first.stateDir, backend: { registerSellerAgent: async () => {} }, sdk: first.fake.sdk });
  const got: TransportMessage[] = [];
  second.onMessage(acme, (m) => got.push(m));
  await second.start([buyer, acme]);
  assert.deepEqual(got.map((m) => [m.id, m.from, m.payload.session_id]), [[ev.id, "buyer", "sess-r"]]);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(first.fake.org.replies.map((r) => [r.handle, r.intent]), [["exchangent-acme-desks", "complete"]]);
  assert.equal(first.fake.calls.createIdentity.length, 2, "identities reused from state");
  await second.close();
});

test("receive: our own reply echoed as a2a.task.message (sender = us) is ignored", async () => {
  const { transport, fake } = makeTransport();
  const got: TransportMessage[] = [];
  transport.onMessage(acme, (m) => got.push(m));
  await transport.send(buyer, acme, opened("s-acme"));
  const sent = fake.org.sent[0];
  const res = await fake.deliver({ ...sent, from: "exchangent-acme-desks" });
  assert.equal(await res.text(), "ignored");
  assert.equal(got.length, 0);
  await transport.close();
});

test("email: sent from the agent's own identity mailbox with the idempotency key", async () => {
  const { transport, fake } = makeTransport();
  await transport.email(buyer, { to: ["person@example.com"], subject: "Deal reached", text: "t", html: "<p>t</p>", idempotencyKey: "exchangent-deal-r1" });
  assert.deepEqual(fake.calls.emails, [{ from: "exchangent-buyer", to: ["person@example.com"], subject: "Deal reached", idempotencyKey: "exchangent-deal-r1" }]);
  await transport.close();
});
