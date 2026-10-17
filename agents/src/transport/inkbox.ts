// Inkbox A2A transport.
//
// Identities are created on demand (first event that involves an agent), each gets an agent-scoped
// API key (required by the A2A protocol endpoint), A2A is enabled, a webhook subscription points at the
// identity's own tunnel (https://<handle>.inkboxwire.com/inkbox/webhook), and an in-process tunnel
// handler receives deliveries. Sends go from the counterparty agent's identity to the recipient's, one
// A2A context per negotiation session, messageId = outbox event id (Inkbox idempotency key).

import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  A2AClient,
  A2AResolvedTarget,
  A2AWebhookEventType,
  A2AWebhookPayload,
  AgentIdentity,
  Inkbox,
  InkboxOptions,
  verifyWebhook,
} from "@inkbox/sdk";
import type { connect, TunnelListener } from "@inkbox/sdk/tunnels/connect";
import { JsonState } from "../state.ts";
import { publicPayload, toMessage } from "./index.ts";
import type { MessageHandler, PublicPayload, Transport, TransportMessage } from "./index.ts";
import type { Agent } from "../agents.ts";
import type { EventKind, WorkerEvent } from "../backend.ts";
import { logger, money, short } from "../log.ts";

const log = logger("transport:inkbox");

export const WEBHOOK_PATH = "/inkbox/webhook";
export const A2A_EVENT_TYPES: A2AWebhookEventType[] = ["a2a.task.created", "a2a.task.message"];

/** The parts of @inkbox/sdk this transport uses (injected in tests). */
export interface InkboxSdk {
  Inkbox: new (options: InkboxOptions) => Inkbox;
  connect: typeof connect;
  verifyWebhook: typeof verifyWebhook;
}

/** Registers a seller's Inkbox handle with the backend (WorkerApi.registerSellerAgent). */
export interface SellerRegistrar {
  registerSellerAgent(sellerId: string, agentHandle: string): Promise<unknown>;
}

/** Dependencies injected next to the config (runner, tests). */
export interface InkboxTransportDeps {
  /** WorkerApi, used to register seller handles */
  backend?: SellerRegistrar;
  /** { Inkbox, connect, verifyWebhook } (injected in tests) */
  sdk?: InkboxSdk;
  now?: () => number;
}

export interface InkboxTransportOptions extends InkboxTransportDeps {
  /** admin-scoped Inkbox key (creates identities, mints agent keys, subscriptions) */
  apiKey?: string;
  baseUrl?: string;
  a2aBaseUrl?: string;
  /** max identities this runner may create (free plan: 3) */
  identityCap?: number;
  handlePrefix?: string;
  stateDir: string;
}

/** One provisioned identity, persisted in .state/identities.json. */
export interface IdentityRecord {
  handle: string;
  identity_id: string;
  public_host: string;
  created_at: string;
  agent_api_key?: string;
  a2a_enabled?: boolean;
  subscription_id?: string;
  signing_key?: string;
  registered?: boolean;
}

export interface InkboxState {
  /** agent id -> identity */
  identities: Record<string, IdentityRecord>;
  /** negotiation session id -> A2A context id */
  contexts: Record<string, string>;
}

/** The `data` part of an A2A message: the public event fields minus the note. */
export type A2AEventData = Omit<PublicPayload, "note"> & { kind: EventKind; event_id: string; created_at: string | null };

/** A2A message parts for one outbox event: one structured data part + a short text part. */
export type A2AEventParts = [{ data: A2AEventData }, { text: string }];

export type SignatureCheck = { ok: true; reason?: undefined } | { ok: false; reason: string };

export class IdentityCapError extends Error {
  code: string;

  constructor(message: string) {
    super(message);
    this.name = "IdentityCapError";
    this.code = "inkbox_identity_cap";
  }
}

/** HTTP status of an Inkbox SDK error (InkboxAPIError.statusCode), if any. */
function statusCode(err: unknown): unknown {
  return (err as { statusCode?: unknown } | null | undefined)?.statusCode;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

/**
 * Verify an Inkbox webhook: X-Inkbox-Timestamp within the 300 s window, then the SDK's
 * verifyWebhook (HMAC-SHA256 over "{request_id}.{timestamp}.{raw_body}", header "sha256=<hex>").
 * The SDK helper does not check the timestamp window itself, so it is checked here.
 */
export function verifyInkboxSignature({
  raw,
  headers,
  secret,
  verify,
  nowMs = Date.now(),
  toleranceSec = 300,
}: {
  raw: Buffer | string;
  headers?: Record<string, string | string[] | undefined> | null;
  secret?: string | null;
  verify: typeof verifyWebhook;
  nowMs?: number;
  toleranceSec?: number;
}): SignatureCheck {
  if (!secret) return { ok: false, reason: "no signing key stored for this identity" };
  const h: Record<string, string | undefined> = {};
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

export function sanitizeHandle(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** Build the A2A message parts for an outbox event: one structured data part + a short text part. */
export function eventParts(fromAgent: Agent | null | undefined, event: WorkerEvent): A2AEventParts {
  const msg = toMessage(fromAgent, event);
  const { note, ...ids } = msg.payload;
  const data: A2AEventData = { kind: msg.kind, event_id: msg.id, created_at: msg.created_at, ...ids };
  const total = ids.total_cents !== undefined ? ` total ${money(ids.total_cents)}` : "";
  const text = `${msg.kind} session ${short(ids.session_id)}${total}${note ? ` - "${String(note).slice(0, 140)}"` : ""}. Re-read the session via MCP before acting.`;
  return [{ data }, { text }];
}

/**
 * True for the data part eventParts() wrote. Only `kind` and `event_id` are checked; the sender is one of
 * our own identities (the webhook signature and caller handle were verified), so the rest is trusted.
 */
function isEventDataPart(p: unknown): p is { data: A2AEventData } {
  return isRecord(p) && isRecord(p.data) && Boolean(p.data.kind && p.data.event_id);
}

/** Reverse of eventParts: find the data part we sent and rebuild the transport message. */
export function messageFromParts(parts: unknown[] | null | undefined, fromAgentId: string | null = null): TransportMessage | null {
  const dataPart = (parts || []).find(isEventDataPart);
  if (!dataPart) return null;
  const d = dataPart.data;
  return { id: d.event_id, kind: d.kind, created_at: d.created_at ?? null, from: fromAgentId, payload: publicPayload(d) };
}

async function loadSdk(): Promise<InkboxSdk> {
  const sdk = await import("@inkbox/sdk");
  const tunnels = await import("@inkbox/sdk/tunnels/connect");
  return { Inkbox: sdk.Inkbox, verifyWebhook: sdk.verifyWebhook, connect: tunnels.connect };
}

export class InkboxTransport implements Transport {
  name = "inkbox";
  #handlers = new Map<string, MessageHandler>();
  #pending = new Map<string, Promise<IdentityRecord>>();
  #listeners = new Map<string, TunnelListener>();
  #agentClients = new Map<string, AgentIdentity>();
  #a2aClients = new Map<string, A2AClient>();
  #cards = new Map<string, A2AResolvedTarget>();
  #seenWebhooks = new Set<string>();
  #agents = new Map<string, Agent>();

  apiKey: string | undefined;
  baseUrl: string | undefined;
  a2aBaseUrl: string;
  identityCap: number;
  handlePrefix: string;
  stateDir: string;
  backend: SellerRegistrar | undefined;
  sdkPromise: Promise<InkboxSdk>;
  now: () => number;
  state: JsonState<InkboxState>;
  /** Admin client, created on first use. */
  admin?: Inkbox;
  /** Set once Inkbox answers 402 (plan limit), so later events fail fast. */
  planLimitError?: string;

  constructor({ apiKey, baseUrl, a2aBaseUrl = "https://inkbox.ai", identityCap = 3, handlePrefix = "exchangent", stateDir, backend, sdk, now = () => Date.now() }: InkboxTransportOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.a2aBaseUrl = a2aBaseUrl;
    this.identityCap = identityCap;
    this.handlePrefix = handlePrefix;
    this.stateDir = stateDir;
    this.backend = backend;
    this.sdkPromise = sdk ? Promise.resolve(sdk) : loadSdk();
    this.now = now;
    this.state = new JsonState<InkboxState>(path.join(stateDir, "identities.json"), { identities: {}, contexts: {} });
  }

  async #sdk(): Promise<InkboxSdk> {
    return this.sdkPromise;
  }

  async #admin(): Promise<Inkbox> {
    if (!this.admin) {
      const { Inkbox } = await this.#sdk();
      this.admin = new Inkbox({ apiKey: this.apiKey, baseUrl: this.baseUrl });
    }
    return this.admin;
  }

  onMessage(agent: Agent, handler: MessageHandler): void {
    this.#handlers.set(agent.id, handler);
    this.#agents.set(agent.id, agent);
  }

  /** Reconnect tunnels for identities created in earlier runs and catch up on queued tasks. */
  async start(agents: Agent[]): Promise<void> {
    for (const agent of agents) {
      this.#agents.set(agent.id, agent);
      if (this.state.data.identities[agent.id]) {
        try {
          await this.ensureIdentity(agent);
          await this.#catchUp(agent);
        } catch (err) {
          log.error("could not resume identity", { agent: agent.id, error: (err as Error).message });
        }
      }
    }
  }

  identityFor(agentId: string): IdentityRecord | null {
    return this.state.data.identities[agentId] || null;
  }

  /** Create (or finish provisioning) the agent's Inkbox identity. Idempotent; safe to call per event. */
  ensureIdentity(agent: Agent, hintHandle?: string): Promise<IdentityRecord> {
    if (!this.#pending.has(agent.id)) {
      const p = this.#provision(agent, hintHandle).finally(() => this.#pending.delete(agent.id));
      this.#pending.set(agent.id, p);
    }
    return this.#pending.get(agent.id)!; // set just above if missing
  }

  async #provision(agent: Agent, hintHandle?: string): Promise<IdentityRecord> {
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
      let signingKey: string | null = null;
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

  async #createIdentity(agent: Agent, hintHandle?: string): Promise<IdentityRecord> {
    const admin = await this.#admin();
    const base = sanitizeHandle(hintHandle || `${this.handlePrefix}-${agent.slug}`);
    const opts = { displayName: agent.name.slice(0, 80), description: `Exchangent ${agent.role} agent` };
    const toRec = (identity: AgentIdentity): IdentityRecord => ({
      handle: identity.agentHandle,
      identity_id: identity.id,
      public_host: identity.tunnel?.publicHost || `${identity.agentHandle}.inkboxwire.com`,
      created_at: new Date().toISOString(),
    });
    const capError = (err: unknown) => {
      this.planLimitError =
        `Inkbox refused to create another identity (HTTP 402: ${(err as Error).message}). The free plan allows 3 identities. ` +
        `Upgrade the plan, seed fewer sellers, or use TRANSPORT=local; restart the runner afterwards.`;
      return new IdentityCapError(this.planLimitError);
    };
    try {
      return toRec(await admin.createIdentity(base, opts));
    } catch (err) {
      if (statusCode(err) === 402) throw capError(err);
      if (statusCode(err) !== 409) throw err;
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
        if (statusCode(err2) === 402) throw capError(err2);
        throw err2;
      }
    }
  }

  async #agentIdentity(agentId: string): Promise<AgentIdentity> {
    if (!this.#agentClients.has(agentId)) {
      const rec = this.state.data.identities[agentId];
      const { Inkbox } = await this.#sdk();
      const client = new Inkbox({ apiKey: rec.agent_api_key, baseUrl: this.baseUrl });
      this.#agentClients.set(agentId, await client.getIdentity(rec.handle));
    }
    return this.#agentClients.get(agentId)!; // set just above if missing
  }

  async #a2a(agentId: string): Promise<A2AClient> {
    if (!this.#a2aClients.has(agentId)) {
      const me = await this.#agentIdentity(agentId);
      this.#a2aClients.set(agentId, await me.a2aClient());
    }
    return this.#a2aClients.get(agentId)!; // set just above if missing
  }

  async #card(fromId: string, handle: string): Promise<A2AResolvedTarget> {
    const key = `${fromId}->${handle}`;
    if (!this.#cards.has(key)) {
      const a2a = await this.#a2a(fromId);
      this.#cards.set(key, await a2a.fetchCard(`${this.a2aBaseUrl}/a2a/${handle}/card`));
    }
    return this.#cards.get(key)!; // set just above if missing
  }

  async #listen(agent: Agent, rec: IdentityRecord): Promise<void> {
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
  async handleWebhook(agentId: string, req: Request): Promise<Response> {
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
    let body: A2AWebhookPayload;
    // The signature check above proves Inkbox sent this body, so it follows the SDK's webhook payload type.
    try { body = JSON.parse(raw.toString("utf8")) as A2AWebhookPayload; } catch { return new Response("bad json", { status: 400 }); }
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

  #completeTask(agentId: string, taskId: string | undefined): void {
    if (!taskId) return;
    this.#agentIdentity(agentId)
      .then((me) => me.a2aReply(taskId, { intent: "complete", text: "received" }))
      .catch((err: unknown) => {
        const message = (err as Error | null | undefined)?.message;
        if (!/terminal/i.test(message || "")) log.warn("a2aReply failed", { agent: agentId, task: taskId, error: message });
      });
  }

  /** Recovery path after downtime: tasks still "submitted" in this identity's inbox. */
  async #catchUp(agent: Agent): Promise<void> {
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
  async send(fromAgent: Agent | null, toAgent: Agent, event: WorkerEvent): Promise<void> {
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
    // A2AWireMessage types its extra fields as unknown; contextId is a string per A2A 1.0.
    const newContext = result?.kind === "task" ? result.task?.contextId : (result?.message?.contextId as string | undefined);
    if (sessionId && newContext && !contextId) {
      this.state.data.contexts[sessionId] = newContext;
      this.state.save();
    }
    log.info("a2a sent", { from: fromAgent.id, to: toRec.handle, kind: event.kind, event: event.id, context: short(newContext || contextId) });
  }

  async close(): Promise<void> {
    for (const l of this.#listeners.values()) await l.close().catch(() => {});
    this.#listeners.clear();
  }
}
