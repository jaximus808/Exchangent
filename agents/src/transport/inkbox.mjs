// Inkbox A2A transport.
//
// Identities are created on demand (first event that involves an agent), each gets an agent-scoped
// API key (required by the A2A protocol endpoint), A2A is enabled, a webhook subscription points at the
// identity's own tunnel (https://<handle>.inkboxwire.com/inkbox/webhook), and an in-process tunnel
// handler receives deliveries. Sends go from the counterparty agent's identity to the recipient's, one
// A2A context per negotiation session, messageId = outbox event id (Inkbox idempotency key).

import path from "node:path";
import { randomBytes } from "node:crypto";
import { JsonState } from "../state.mjs";
import { publicPayload, toMessage } from "./index.mjs";
import { logger, money, short } from "../log.mjs";

const log = logger("transport:inkbox");

export const WEBHOOK_PATH = "/inkbox/webhook";
export const A2A_EVENT_TYPES = ["a2a.task.created", "a2a.task.message"];

export class IdentityCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdentityCapError";
    this.code = "inkbox_identity_cap";
  }
}

/**
 * Verify an Inkbox webhook: X-Inkbox-Timestamp within the 300 s window, then the SDK's
 * verifyWebhook (HMAC-SHA256 over "{request_id}.{timestamp}.{raw_body}", header "sha256=<hex>").
 * The SDK helper does not check the timestamp window itself, so it is checked here.
 */
export function verifyInkboxSignature({ raw, headers, secret, verify, nowMs = Date.now(), toleranceSec = 300 }) {
  if (!secret) return { ok: false, reason: "no signing key stored for this identity" };
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const ts = Number(h["x-inkbox-timestamp"]);
  if (!h["x-inkbox-signature"] || !h["x-inkbox-request-id"] || !Number.isFinite(ts)) {
    return { ok: false, reason: "missing X-Inkbox-* signature headers" };
  }
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return { ok: false, reason: "timestamp outside 300s window" };
  let ok = false;
  try {
    ok = verify({ payload: raw, headers: h, secret });
  } catch {
    ok = false; // timingSafeEqual throws on length mismatch
  }
  return ok ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

export function sanitizeHandle(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** Build the A2A message parts for an outbox event: one structured data part + a short text part. */
export function eventParts(fromAgent, event) {
  const msg = toMessage(fromAgent, event);
  const { note, ...ids } = msg.payload;
  const data = { kind: msg.kind, event_id: msg.id, created_at: msg.created_at, ...ids };
  const total = ids.total_cents !== undefined ? ` total ${money(ids.total_cents)}` : "";
  const text = `${msg.kind} session ${short(ids.session_id)}${total}${note ? ` - "${String(note).slice(0, 140)}"` : ""}. Re-read the session via MCP before acting.`;
  return [{ data }, { text }];
}

/** Reverse of eventParts: find the data part we sent and rebuild the transport message. */
export function messageFromParts(parts, fromAgentId = null) {
  const dataPart = (parts || []).find((p) => p && typeof p.data === "object" && p.data?.kind && p.data?.event_id);
  if (!dataPart) return null;
  const d = dataPart.data;
  return { id: d.event_id, kind: d.kind, created_at: d.created_at ?? null, from: fromAgentId, payload: publicPayload(d) };
}

async function loadSdk() {
  const sdk = await import("@inkbox/sdk");
  const tunnels = await import("@inkbox/sdk/tunnels/connect");
  return { Inkbox: sdk.Inkbox, verifyWebhook: sdk.verifyWebhook, connect: tunnels.connect };
}

export class InkboxTransport {
  name = "inkbox";
  #handlers = new Map();
  #pending = new Map();
  #listeners = new Map();
  #agentClients = new Map();
  #a2aClients = new Map();
  #cards = new Map();
  #seenWebhooks = new Set();
  #agents = new Map();

  /**
   * @param {object} o
   * @param {string} o.apiKey admin-scoped Inkbox key (creates identities, mints agent keys, subscriptions)
   * @param {number} o.identityCap max identities this runner may create (free plan: 3)
   * @param {object} [o.backend] WorkerApi, used to register seller handles
   * @param {object} [o.sdk] { Inkbox, connect, verifyWebhook } (injected in tests)
   */
  constructor({ apiKey, baseUrl, a2aBaseUrl = "https://inkbox.ai", identityCap = 3, handlePrefix = "exchangent", stateDir, backend, sdk, now = () => Date.now() }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.a2aBaseUrl = a2aBaseUrl;
    this.identityCap = identityCap;
    this.handlePrefix = handlePrefix;
    this.stateDir = stateDir;
    this.backend = backend;
    this.sdkPromise = sdk ? Promise.resolve(sdk) : loadSdk();
    this.now = now;
    this.state = new JsonState(path.join(stateDir, "identities.json"), { identities: {}, contexts: {} });
  }

  async #sdk() {
    return this.sdkPromise;
  }

  async #admin() {
    if (!this.admin) {
      const { Inkbox } = await this.#sdk();
      this.admin = new Inkbox({ apiKey: this.apiKey, baseUrl: this.baseUrl });
    }
    return this.admin;
  }

  onMessage(agent, handler) {
    this.#handlers.set(agent.id, handler);
    this.#agents.set(agent.id, agent);
  }

  /** Reconnect tunnels for identities created in earlier runs and catch up on queued tasks. */
  async start(agents) {
    for (const agent of agents) {
      this.#agents.set(agent.id, agent);
      if (this.state.data.identities[agent.id]) {
        try {
          await this.ensureIdentity(agent);
          await this.#catchUp(agent);
        } catch (err) {
          log.error("could not resume identity", { agent: agent.id, error: err.message });
        }
      }
    }
  }

  identityFor(agentId) {
    return this.state.data.identities[agentId] || null;
  }

  /** Create (or finish provisioning) the agent's Inkbox identity. Idempotent; safe to call per event. */
  ensureIdentity(agent, hintHandle) {
    if (!this.#pending.has(agent.id)) {
      const p = this.#provision(agent, hintHandle).finally(() => this.#pending.delete(agent.id));
      this.#pending.set(agent.id, p);
    }
    return this.#pending.get(agent.id);
  }

  async #provision(agent, hintHandle) {
    const ids = this.state.data.identities;
    let rec = ids[agent.id];
    if (!rec) {
      if (this.planLimitError) throw new IdentityCapError(this.planLimitError); // don't hammer Inkbox every poll
      const used = Object.keys(ids).length;
      if (used >= this.identityCap) {
        throw new IdentityCapError(
          `Inkbox identity cap reached (${used}/${this.identityCap}: ${Object.values(ids).map((r) => r.handle).join(", ")}). ` +
            `Cannot create an identity for ${agent.name} (${agent.id}). The Inkbox free plan allows 3 identities and this demo ` +
            `needs 1 buyer + 1 per seller. Upgrade the plan and raise INKBOX_IDENTITY_CAP, seed fewer sellers, or use TRANSPORT=local.`,
        );
      }
      rec = await this.#createIdentity(agent, hintHandle);
      ids[agent.id] = rec;
      this.state.save();
      log.info("identity created", { agent: agent.id, handle: rec.handle });
    }
    const admin = await this.#admin();

    if (!rec.agent_api_key) {
      // A2A protocol calls require the identity's own agent-scoped key; admin keys are rejected there.
      const created = await admin.apiKeys.create({ label: `exchangent ${agent.id}`.slice(0, 255), description: "Exchangent agent runner (A2A)", scopedIdentityId: rec.identity_id });
      rec.agent_api_key = created.apiKey;
      this.state.save();
      log.info("agent-scoped key minted", { agent: agent.id, handle: rec.handle });
    }

    if (!rec.a2a_enabled) {
      const me = await this.#agentIdentity(agent.id);
      await me.a2aEnable();
      rec.a2a_enabled = true;
      this.state.save();
    }

    if (!rec.subscription_id || !rec.signing_key) {
      const url = `https://${rec.public_host}${WEBHOOK_PATH}`;
      const existing = await admin.webhooks.subscriptions.list({ agentIdentityId: rec.identity_id, url }).catch(() => []);
      let signingKey = null;
      if (existing.length) {
        rec.subscription_id = existing[0].id;
      } else {
        const sub = await admin.webhooks.subscriptions.create({ agentIdentityId: rec.identity_id, url, eventTypes: A2A_EVENT_TYPES });
        rec.subscription_id = sub.id;
        signingKey = sub.signingKey;
      }
      if (!signingKey) {
        // The key is shown only once; if we don't have it, rotate to get a fresh one.
        signingKey = (await admin.signingKeys.createOrRotate(rec.handle)).signingKey;
      }
      rec.signing_key = signingKey;
      this.state.save();
      log.info("webhook subscribed", { agent: agent.id, url });
    }

    if (agent.role === "seller" && !rec.registered && this.backend) {
      await this.backend.registerSellerAgent(agent.sellerId, rec.handle);
      rec.registered = true;
      this.state.save();
      log.info("seller agent registered with backend", { agent: agent.id, handle: rec.handle });
    }

    if (!this.#listeners.has(agent.id)) await this.#listen(agent, rec);
    return rec;
  }

  async #createIdentity(agent, hintHandle) {
    const admin = await this.#admin();
    const base = sanitizeHandle(hintHandle || `${this.handlePrefix}-${agent.slug}`);
    const opts = { displayName: agent.name.slice(0, 80), description: `Exchangent ${agent.role} agent` };
    const toRec = (identity) => ({
      handle: identity.agentHandle,
      identity_id: identity.id,
      public_host: identity.tunnel?.publicHost || `${identity.agentHandle}.inkboxwire.com`,
      created_at: new Date().toISOString(),
    });
    const capError = (err) => {
      this.planLimitError =
        `Inkbox refused to create another identity (HTTP 402: ${err.message}). The free plan allows 3 identities. ` +
        `Upgrade the plan, seed fewer sellers, or use TRANSPORT=local; restart the runner afterwards.`;
      return new IdentityCapError(this.planLimitError);
    };
    try {
      return toRec(await admin.createIdentity(base, opts));
    } catch (err) {
      if (err?.statusCode === 402) throw capError(err);
      if (err?.statusCode !== 409) throw err;
      // Handle taken. If it is ours (state was lost), adopt it; otherwise add a random suffix once.
      try {
        const mine = await admin.getIdentity(base);
        log.warn("adopting existing identity (local state was missing)", { agent: agent.id, handle: base });
        return toRec(mine);
      } catch { /* not in our org */ }
      const retry = sanitizeHandle(`${base.slice(0, 56)}-${randomBytes(2).toString("hex")}`);
      try {
        return toRec(await admin.createIdentity(retry, opts));
      } catch (err2) {
        if (err2?.statusCode === 402) throw capError(err2);
        throw err2;
      }
    }
  }

  async #agentIdentity(agentId) {
    if (!this.#agentClients.has(agentId)) {
      const rec = this.state.data.identities[agentId];
      const { Inkbox } = await this.#sdk();
      const client = new Inkbox({ apiKey: rec.agent_api_key, baseUrl: this.baseUrl });
      this.#agentClients.set(agentId, await client.getIdentity(rec.handle));
    }
    return this.#agentClients.get(agentId);
  }

  async #a2a(agentId) {
    if (!this.#a2aClients.has(agentId)) {
      const me = await this.#agentIdentity(agentId);
      this.#a2aClients.set(agentId, await me.a2aClient());
    }
    return this.#a2aClients.get(agentId);
  }

  async #card(fromId, handle) {
    const key = `${fromId}->${handle}`;
    if (!this.#cards.has(key)) {
      const a2a = await this.#a2a(fromId);
      this.#cards.set(key, await a2a.fetchCard(`${this.a2aBaseUrl}/a2a/${handle}/card`));
    }
    return this.#cards.get(key);
  }

  async #listen(agent, rec) {
    const { connect } = await this.#sdk();
    const admin = await this.#admin();
    const listener = await connect(admin, {
      name: rec.handle,
      handler: (req) => this.handleWebhook(agent.id, req),
      installSignalHandlers: false,
      stateDir: path.join(this.stateDir, "tunnels", rec.handle),
    });
    this.#listeners.set(agent.id, listener);
    log.info("tunnel online", { agent: agent.id, url: listener.publicUrl });
  }

  /** Tunnel handler: verify, dedupe, ack the A2A task fast, push into the agent mailbox. */
  async handleWebhook(agentId, req) {
    if (req.method !== "POST") return new Response("ok");
    if (new URL(req.url).pathname !== WEBHOOK_PATH) return new Response("not found", { status: 404 });
    const raw = Buffer.from(await req.arrayBuffer());
    const headers = Object.fromEntries(req.headers);
    const rec = this.state.data.identities[agentId];
    const { verifyWebhook } = await this.#sdk();
    const check = verifyInkboxSignature({ raw, headers, secret: rec?.signing_key, verify: verifyWebhook, nowMs: this.now() });
    if (!check.ok) {
      log.warn("webhook rejected", { agent: agentId, reason: check.reason });
      return new Response("invalid signature", { status: 401 });
    }
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return new Response("bad json", { status: 400 }); }
    if (this.#seenWebhooks.has(body.id)) return new Response("duplicate");
    this.#seenWebhooks.add(body.id);
    if (!A2A_EVENT_TYPES.includes(body.event_type)) return new Response("ignored");

    const callerHandle = body.data?.caller?.handle;
    const fromId = Object.entries(this.state.data.identities).find(([, r]) => r.handle === callerHandle)?.[0];
    if (!fromId) {
      log.warn("webhook from unknown caller ignored", { agent: agentId, caller: callerHandle });
      return new Response("ignored");
    }
    const msg = messageFromParts(body.data?.parts, fromId);
    if (!msg) return new Response("ignored");

    // Ack fast: complete the task so the sender's ledger shows delivery. Never blocks the response.
    this.#completeTask(agentId, body.data.task_id);
    const handler = this.#handlers.get(agentId);
    if (handler) await handler(msg);
    return new Response("ok");
  }

  #completeTask(agentId, taskId) {
    if (!taskId) return;
    this.#agentIdentity(agentId)
      .then((me) => me.a2aReply(taskId, { intent: "complete", text: "received" }))
      .catch((err) => {
        if (!/terminal/i.test(err?.message || "")) log.warn("a2aReply failed", { agent: agentId, task: taskId, error: err?.message });
      });
  }

  /** Recovery path after downtime: tasks still "submitted" in this identity's inbox. */
  async #catchUp(agent) {
    const me = await this.#agentIdentity(agent.id);
    const handler = this.#handlers.get(agent.id);
    if (!handler || typeof me.iterA2ATasks !== "function") return;
    for await (const task of me.iterA2ATasks({ state: "submitted" })) {
      const full = await me.a2aTask(task.id);
      const fromId = Object.entries(this.state.data.identities).find(([, r]) => r.handle === full.caller?.handle)?.[0];
      if (!fromId) continue;
      const msg = messageFromParts(full.messages?.at(-1)?.parts, fromId);
      if (!msg) continue;
      this.#completeTask(agent.id, task.id);
      log.info("caught up queued task", { agent: agent.id, kind: msg.kind, event: msg.id });
      await handler(msg);
    }
  }

  /** Send one outbox event as an A2A message from fromAgent's identity to toAgent's identity. */
  async send(fromAgent, toAgent, event) {
    if (!fromAgent) {
      throw new Error(`cannot tell which seller sent ${event.kind}; the backend should set route.seller_id on buyer-bound events`);
    }
    await this.ensureIdentity(fromAgent);
    const toRec = await this.ensureIdentity(toAgent, event.route?.agent_handle);
    const a2a = await this.#a2a(fromAgent.id);
    const target = await this.#card(fromAgent.id, toRec.handle);
    const sessionId = event.payload?.session_id;
    const contextId = sessionId ? this.state.data.contexts[sessionId] : undefined;
    const result = await a2a.send(target, {
      messageId: event.id,
      ...(contextId ? { contextId } : {}),
      parts: eventParts(fromAgent, event),
    });
    const newContext = result?.kind === "task" ? result.task?.contextId : result?.message?.contextId;
    if (sessionId && newContext && !contextId) {
      this.state.data.contexts[sessionId] = newContext;
      this.state.save();
    }
    log.info("a2a sent", { from: fromAgent.id, to: toRec.handle, kind: event.kind, event: event.id, context: short(newContext || contextId) });
  }

  async close() {
    for (const l of this.#listeners.values()) await l.close().catch(() => {});
    this.#listeners.clear();
  }
}
