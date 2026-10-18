// "Email your agent" (doc/resolution-contract.md, "Agents"): a person emails their agent's Inkbox address and
// gets a status reply in the same thread. Read-only: it never reserves, pays, counters or changes anything.
//
//   to the buyer agent (exchangent-buyer)   the sender's delegated, open requests: best offer, open sessions, status,
//                                           and the live watch link (GET /worker/buyer-requests?email=<sender>)
//   to a seller agent                       the business's open negotiations, only if the sender is the owner
//
// The reply always goes to the registered email that matched (the lookup is by that exact address), never to a
// Reply-To header, so a forged From learns nothing: the status goes to the real owner. Unknown senders get no
// reply (no backscatter). Auto-replies, bounces and mail from our own identities are ignored. At most
// RATE_MAX replies per sender per hour. Polls each identity's inbox with a per-identity cursor in .state; on the
// first run the cursor starts at "now", so old mail is never answered.

import path from "node:path";
import type { Agent, AgentRegistry, SellerAgent } from "./agents.ts";
import { BackendError } from "./backend.ts";
import type { BuyerRequestStatus } from "./backend.ts";
import type { McpToolClient } from "./mcp.ts";
import { isToolError } from "./mcp.ts";
import { businessFromResult } from "./notify.ts";
import type { EmailMessage } from "./notify.ts";
import { JsonState } from "./state.ts";
import type { InboundEmail, Transport } from "./transport/index.ts";
import { logger, money, short } from "./log.ts";

const log = logger("inbound");

export const RATE_MAX = 10;
export const RATE_WINDOW_MS = 60 * 60_000;
const SEEN_MAX = 500;

const AUTO_FROM = /(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/i;
const AUTO_SUBJECT = /^\s*(auto(matic)?[ -]?(reply|response)|auto:|out of (the )?office|undeliver|delivery status notification|returned mail|failure notice|mail delivery (failed|system))/i;

/** True for auto-replies and bounces (never answered: two auto-responders must not ping-pong). */
export function isAutomated(mail: Pick<InboundEmail, "from" | "subject">): boolean {
  return AUTO_FROM.test(mail.from || "") || AUTO_SUBJECT.test(mail.subject || "");
}

const normEmail = (s: string | null | undefined) => String(s || "").trim().toLowerCase();
const reSubject = (s: string | null | undefined) => (/^\s*re:/i.test(s || "") ? String(s) : `Re: ${s || "your order"}`).slice(0, 200);
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Status reply for a buyer: one block per request. */
export function buyerStatusReply(requests: BuyerRequestStatus[], webUrl: string): { text: string; html: string } {
  const lines: string[] = [];
  const blocks: string[] = [];
  if (!requests.length) {
    lines.push("You have no open orders that your agent is negotiating right now.");
    blocks.push(`<p>${esc(lines[0])}</p>`);
  }
  for (const r of requests) {
    const best = r.best_offer ? `${r.best_offer.seller_name} at ${money(r.best_offer.total_cents)}` : "no offer yet";
    const watch = r.watch_path ? `${webUrl.replace(/\/$/, "")}${r.watch_path}` : null;
    const block = [
      `"${r.title || "Your order"}" (${r.status || "negotiating"})`,
      `Best offer so far: ${best}`,
      `Sellers still negotiating: ${r.sessions_open ?? 0}`,
      ...(watch ? [`Watch live: ${watch}`] : []),
    ];
    lines.push(...block, "");
    blocks.push(`<p><b>${esc(block[0])}</b><br>${block.slice(1).map((l) => (l.startsWith("Watch live: ") && watch ? `Watch live: <a href="${esc(watch)}">${esc(watch)}</a>` : esc(l))).join("<br>")}</p>`);
  }
  const footer = "To reserve or pay, open Claude (Exchangent connector). I only report status by email; I never buy from an email.";
  lines.push(footer, "", "- Your Exchangent buyer agent");
  blocks.push(`<p>${esc(footer)}</p><p>- Your Exchangent buyer agent</p>`);
  return { text: lines.join("\n"), html: blocks.join("") };
}

/** Status reply for a business owner, from list_my_requests. */
export function sellerStatusReply(business: string, raw: unknown): { text: string; html: string } {
  const top = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(top.sessions) ? top.sessions : Array.isArray(top.requests) ? top.requests : Array.isArray(raw) ? raw : [];
  const rows = list.slice(0, 20).map((x) => {
    const s = (x !== null && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const req = (s.request && typeof s.request === "object" ? s.request : {}) as Record<string, unknown>;
    const offer = (s.current_offer && typeof s.current_offer === "object" ? s.current_offer : {}) as Record<string, unknown>;
    const title = String(req.title ?? s.title ?? "A buy request");
    const total = typeof offer.total_cents === "number" ? `, our offer ${money(offer.total_cents)}` : "";
    const turn = s.turn === "seller" ? "your agent's move" : s.turn === "buyer" ? "buyer's move" : String(s.status ?? "");
    return `${title}: ${turn}, round ${s.rounds ?? 0}${total}`;
  });
  const head = rows.length ? `${business} has ${rows.length} open negotiation${rows.length === 1 ? "" : "s"}:` : `${business} has no open negotiations right now.`;
  const footer = "I only report status by email. Change prices or stock in Claude (Exchangent connector, signed in as your business).";
  const text = [head, ...rows.map((r) => `- ${r}`), "", footer, "", `- ${business} sales agent`].join("\n");
  const html = `<p>${esc(head)}</p>${rows.length ? `<ul>${rows.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}<p>${esc(footer)}</p><p>- ${esc(business)} sales agent</p>`;
  return { text, html };
}

interface InboundState {
  /** agent id -> ISO time of the newest message handled */
  cursors: Record<string, string>;
  /** recently handled message ids (bounded) */
  seen: string[];
}

export interface InboundResponderOptions {
  transport: Transport;
  registry: Pick<AgentRegistry, "all">;
  api: { buyerRequestsByEmail(email: string): Promise<BuyerRequestStatus[]> };
  mcpFor: (agent: Agent) => Promise<Pick<McpToolClient, "call">>;
  stateDir: string;
  webUrl: string;
  pollMs?: number;
  now?: () => number;
}

export class InboundResponder {
  transport: Transport;
  registry: Pick<AgentRegistry, "all">;
  api: InboundResponderOptions["api"];
  mcpFor: InboundResponderOptions["mcpFor"];
  webUrl: string;
  pollMs: number;
  now: () => number;
  state: JsonState<InboundState>;
  #sent = new Map<string, number[]>(); // sender -> reply timestamps (rate limit)
  #own: Set<string> | null = null;
  #buyerLookupMissing = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #running: Promise<void> | null = null;

  constructor({ transport, registry, api, mcpFor, stateDir, webUrl, pollMs = 30_000, now = () => Date.now() }: InboundResponderOptions) {
    this.transport = transport;
    this.registry = registry;
    this.api = api;
    this.mcpFor = mcpFor;
    this.webUrl = webUrl;
    this.pollMs = pollMs;
    this.now = now;
    this.state = new JsonState<InboundState>(path.join(stateDir, "inbound.json"), { cursors: {}, seen: [] });
  }

  /** Only transports with a real mailbox (Inkbox) can receive email. */
  get supported(): boolean {
    return typeof this.transport.inboundEmails === "function";
  }

  start(): void {
    if (!this.supported) return;
    this.#stopped = false;
    const loop = async () => {
      if (this.#stopped) return;
      this.#running = this.poll().then(() => {}, (err) => log.error("inbound poll failed", { error: (err as Error).message }));
      await this.#running;
      this.#running = null;
      if (!this.#stopped) this.#timer = setTimeout(loop, this.pollMs);
    };
    this.#timer = setTimeout(loop, 1000);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer ?? undefined);
    await this.#running;
  }

  async #ownAddresses(): Promise<Set<string>> {
    if (!this.#own) this.#own = new Set(((await this.transport.ownEmailAddresses?.()) || []).map(normEmail));
    return this.#own;
  }

  #rateOk(sender: string): boolean {
    const t = this.now();
    const recent = (this.#sent.get(sender) || []).filter((x) => t - x < RATE_WINDOW_MS);
    this.#sent.set(sender, recent);
    return recent.length < RATE_MAX;
  }

  #markSeen(id: string): void {
    const seen = this.state.data.seen;
    seen.push(id);
    if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
  }

  /** One pass over every agent that has a mailbox here. */
  async poll(): Promise<number> {
    if (!this.supported) return 0;
    let replies = 0;
    for (const agent of this.registry.all()) {
      if (this.transport.hasMailbox?.(agent) === false) continue;
      try {
        replies += await this.#pollAgent(agent);
      } catch (err) {
        log.warn("inbox read failed", { agent: agent.id, error: (err as Error).message });
      }
    }
    return replies;
  }

  async #pollAgent(agent: Agent): Promise<number> {
    const cursors = this.state.data.cursors;
    if (!cursors[agent.id]) {
      // First time: start from now; never answer mail that arrived before the runner did.
      cursors[agent.id] = new Date(this.now()).toISOString();
      this.state.save();
      return 0;
    }
    const since = new Date(cursors[agent.id]);
    const mails = await this.transport.inboundEmails!(agent, since);
    let replies = 0;
    const own = await this.#ownAddresses();
    for (const mail of mails) {
      if (this.state.data.seen.includes(mail.id)) continue;
      this.#markSeen(mail.id);
      if (mail.createdAt > cursors[agent.id]) cursors[agent.id] = mail.createdAt;
      this.state.save();
      const sender = normEmail(mail.from);
      if (!sender || own.has(sender)) continue;
      if (isAutomated(mail)) {
        log.info("ignored automated mail", { agent: agent.id, from: sender.replace(/^.*@/, "*@") });
        continue;
      }
      if (!this.#rateOk(sender)) {
        log.warn("reply rate limit reached", { agent: agent.id, from: sender.replace(/^.*@/, "*@") });
        continue;
      }
      const sent = agent.role === "buyer" ? await this.#answerBuyer(agent, mail, sender) : await this.#answerSeller(agent, mail, sender);
      if (sent) {
        replies++;
        this.#sent.get(sender)!.push(this.now());
      }
      await this.transport.markEmailsRead?.(agent, [mail.id]).catch(() => {});
    }
    return replies;
  }

  async #reply(agent: Agent, mail: InboundEmail, to: string, body: { text: string; html: string }): Promise<boolean> {
    const message: EmailMessage = {
      to: [to],
      subject: reSubject(mail.subject),
      text: body.text,
      html: body.html,
      idempotencyKey: `exchangent-inbound-${mail.id}`,
      ...(mail.messageId ? { inReplyToMessageId: mail.messageId } : {}),
    };
    await this.transport.email(agent, message);
    log.info("status reply sent", { agent: agent.id, to: to.replace(/^.*@/, "*@"), mail: short(mail.id) });
    return true;
  }

  async #answerBuyer(agent: Agent, mail: InboundEmail, sender: string): Promise<boolean> {
    if (this.#buyerLookupMissing) return false;
    let requests: BuyerRequestStatus[];
    try {
      requests = await this.api.buyerRequestsByEmail(sender);
    } catch (err) {
      if (err instanceof BackendError && err.status === 404 && err.code === "not_found") {
        this.#buyerLookupMissing = true; // old backend without the route: stay quiet until restart
        log.warn("backend has no /worker/buyer-requests yet; email-your-agent is off", {});
        return false;
      }
      throw err;
    }
    // The lookup is by this exact address, so the reply goes to the registered email (never a Reply-To).
    if (!requests.length) {
      log.info("mail from an address with no delegated orders; no reply", { agent: agent.id, from: sender.replace(/^.*@/, "*@") });
      return false;
    }
    return this.#reply(agent, mail, sender, buyerStatusReply(requests, this.webUrl));
  }

  async #answerSeller(agent: Agent, mail: InboundEmail, sender: string): Promise<boolean> {
    const seller = agent as SellerAgent;
    const mcp = await this.mcpFor(seller);
    const bizRaw = await mcp.call("get_business", {});
    if (isToolError(bizRaw)) return false;
    const biz = businessFromResult(bizRaw);
    if (!biz.ownerEmail || normEmail(biz.ownerEmail) !== sender) {
      log.info("mail to a seller agent from someone other than the owner; no reply", { agent: agent.id });
      return false;
    }
    const list = await mcp.call("list_my_requests", {});
    if (isToolError(list)) return false;
    return this.#reply(agent, mail, biz.ownerEmail, sellerStatusReply(biz.name || seller.name, list));
  }
}
