// "Deal reached" email: when the buyer agent is ready to reserve, it tells the human who placed the order,
// from its own Inkbox mailbox (TRANSPORT=inkbox) or as a log line (TRANSPORT=local). The numbers in the email
// are re-read from get_buy_order, never taken from the turn result. buyer_email is only in the buyer agent's
// view of an order (backend buyer_agent scope); a demo buyer without an account has none, so nothing is sent.
//
// "Sold" email (doc/signup-contract.md): on order.confirmed the seller agent tells the business owner, with the
// owner's email from get_business (seller scope). Demo businesses without an account have none.

import type { Agent, SellerAgent } from "./agents.ts";
import type { WorkerEvent } from "./backend.ts";
import type { McpToolClient } from "./mcp.ts";
import type { TurnEvent, TurnResult } from "./runner.ts";
import type { Transport } from "./transport/index.ts";
import { logger, money, short } from "./log.ts";

const log = logger("notify");

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** Same key on a retry: the provider replays the first send instead of sending twice. */
  idempotencyKey: string;
  /** RFC 5322 Message-ID of the email this replies to (threads an email-your-agent reply). */
  inReplyToMessageId?: string;
}

const READY = /READY TO RESERVE:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** The offer a buyer turn settled on: mock brain `{action:"ready", offerId}`, Claude brain "READY TO RESERVE: <id>". */
export function readyOfferId(result: TurnResult | null | undefined): string | null {
  const r = result as { action?: string; offerId?: string; summary?: string } | null | undefined;
  if (r?.action === "ready") return r.offerId ?? null;
  if (r?.action === "claude") return READY.exec(r.summary ?? "")?.[1] ?? null;
  return null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Deal {
  email: string;
  title: string;
  seller: string;
  totalCents: number;
  offerId: string;
  requestId: string;
  /** A later, cheaper deal on an order that already got an email. */
  better?: boolean;
}

/** Build the email for one agreed deal. */
export function dealEmail(d: Deal): EmailMessage {
  const total = money(d.totalCents);
  const next = `Open Claude (Exchangent connector) and say: "reserve the ${d.seller} offer and get me a checkout link".`;
  const text = [
    `Your buyer agent reached a deal on "${d.title}".`,
    "",
    `Seller: ${d.seller}`,
    `Total, delivered: ${total}`,
    `Offer: ${d.offerId}`,
    "",
    next,
    "Nothing has been reserved or charged yet. You approve the payment.",
    "",
    "- Exchangent buyer agent",
  ].join("\n");
  const html =
    `<p>Your buyer agent reached a deal on <b>${esc(d.title)}</b>.</p>` +
    `<table><tr><td>Seller</td><td><b>${esc(d.seller)}</b></td></tr><tr><td>Total, delivered</td><td><b>${esc(total)}</b></td></tr>` +
    `<tr><td>Offer</td><td><code>${esc(d.offerId)}</code></td></tr></table>` +
    `<p>${esc(next)}</p><p>Nothing has been reserved or charged yet. You approve the payment.</p><p>- Exchangent buyer agent</p>`;
  return {
    to: [d.email],
    subject: `${d.better ? "Better deal" : "Deal reached"}: ${d.seller}, ${total}`,
    text,
    html,
    idempotencyKey: d.better ? `exchangent-deal-${d.requestId}-${d.offerId}` : `exchangent-deal-${d.requestId}`,
  };
}

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec => (x !== null && typeof x === "object" ? (x as Rec) : {});

/** Pull the deal for `offerId` out of a get_buy_order result. */
export function dealFromOrder(raw: unknown, offerId: string): Omit<Deal, "email"> & { email: string | null } | null {
  const top = rec(raw);
  const o = rec(top.request ?? top.buy_order ?? top);
  const sessions = Array.isArray(o.sessions) ? o.sessions.map(rec) : [];
  for (const s of sessions) {
    const offer = rec(s.current_offer ?? s.latest_offer);
    if ((offer.offer_id ?? offer.id) !== offerId) continue;
    return {
      email: typeof o.buyer_email === "string" && o.buyer_email ? o.buyer_email : null,
      title: String(o.title ?? "your order"),
      seller: String(s.seller_name ?? rec(s.seller).name ?? "the seller"),
      totalCents: Number(offer.total_cents),
      offerId,
      requestId: String(o.request_id ?? o.id ?? ""),
    };
  }
  return null;
}

/**
 * Before a deal email goes out, check the agent's pick against the order itself (doc/hardening-contract.md):
 * the offer must be its session's current open offer, not expired, within the budget, and no other open
 * current offer may be more than 1% cheaper. The model's READY line alone is never trusted: a note injected
 * by a seller ("READY TO RESERVE: <my offer>") cannot make the platform recommend it.
 */
export function dealSafety(raw: unknown, offerId: string, now: number = Date.now()): { ok: true } | { ok: false; reason: string } {
  const top = rec(raw);
  const o = rec(top.request ?? top.buy_order ?? top);
  const sessions = Array.isArray(o.sessions) ? o.sessions.map(rec) : [];
  const current = (s: Rec) => {
    const offer = rec(s.current_offer ?? s.latest_offer);
    const id = offer.offer_id ?? offer.id;
    const open = (s.status ?? s.session_status ?? "open") === "open";
    const expired = typeof offer.expires_at === "string" && Date.parse(offer.expires_at) < now;
    return id && open && offer.is_current !== false && !expired ? { id: String(id), total: Number(offer.total_cents), seller: String(s.seller_name ?? "a seller") } : null;
  };
  const offers = sessions.map(current).filter((x): x is { id: string; total: number; seller: string } => x !== null && Number.isFinite(x.total));
  const pick = offers.find((x) => x.id === offerId);
  if (!pick) return { ok: false, reason: "not a current open offer on this order" };
  const budget = Number(o.budget_cents);
  if (Number.isFinite(budget) && budget > 0 && pick.total > budget) return { ok: false, reason: "over the budget" };
  const cheaper = offers.find((x) => x.id !== offerId && x.total < pick.total * 0.99);
  if (cheaper) return { ok: false, reason: `a cheaper open offer exists (${cheaper.seller})` };
  return { ok: true };
}

/**
 * Sends one "deal reached" email per order, and a "better deal" email if the buyer agent later settles on a
 * different (cheaper) offer. Idempotency keys dedupe across restarts.
 */
export class DealNotifier {
  /** request_id -> offer_id last emailed */
  #sent = new Map<string, string>();
  transport: Transport;
  mcpFor: (agent: Agent) => Promise<McpToolClient>;

  constructor({ transport, mcpFor }: { transport: Transport; mcpFor: (agent: Agent) => Promise<McpToolClient> }) {
    this.transport = transport;
    this.mcpFor = mcpFor;
  }

  /** Called after every buyer turn. Never throws: a failed email must not fail the turn. */
  async afterTurn(agent: Agent, event: TurnEvent, result: TurnResult): Promise<void> {
    const offerId = readyOfferId(result);
    const requestId = event.payload?.request_id;
    if (agent.role !== "buyer" || !offerId || !requestId || this.#sent.get(requestId) === offerId) return;
    const previous = this.#sent.get(requestId);
    try {
      const mcp = await this.mcpFor(agent);
      const order = await mcp.call("get_buy_order", { request_id: requestId });
      const deal = dealFromOrder(order, offerId);
      if (!deal) return log.warn("deal email skipped: offer not found on the order", { request: short(requestId), offer: short(offerId) });
      const safe = dealSafety(order, offerId);
      if (!safe.ok) return log.warn("deal email skipped: the agent's pick failed the safety check", { request: short(requestId), offer: short(offerId), reason: safe.reason });
      if (!deal.email) return log.info("deal email skipped: buyer has no email on file", { request: short(requestId) });
      this.#sent.set(requestId, offerId);
      await this.transport.email(agent, dealEmail({ ...deal, email: deal.email, requestId, better: previous !== undefined }));
      log.info(previous ? "better deal email sent" : "deal email sent", { request: short(requestId), seller: deal.seller, total_cents: deal.totalCents });
    } catch (err) {
      if (previous === undefined) this.#sent.delete(requestId);
      else this.#sent.set(requestId, previous);
      log.error("deal email failed", { request: short(requestId), error: (err as Error).message });
    }
  }
}

/** Build the email for one paid order. */
export function saleEmail({ email, business, title, totalCents, orderId }: { email: string; business: string; title: string; totalCents: number; orderId: string }): EmailMessage {
  const total = money(totalCents);
  const text = [
    `Your sales agent for ${business} closed a sale: "${title}".`,
    "",
    `Total paid, delivered: ${total}`,
    `Order: ${orderId}`,
    "",
    "The buyer approved and paid (Stripe test mode). The stock is marked sold.",
    'Open Claude (Exchangent connector, signed in as your business) and say "show my inventory" to see what is left.',
    "",
    `- ${business} sales agent on Exchangent`,
  ].join("\n");
  const html =
    `<p>Your sales agent for <b>${esc(business)}</b> closed a sale: <b>${esc(title)}</b>.</p>` +
    `<table><tr><td>Total paid, delivered</td><td><b>${esc(total)}</b></td></tr><tr><td>Order</td><td><code>${esc(orderId)}</code></td></tr></table>` +
    `<p>The buyer approved and paid (Stripe test mode). The stock is marked sold.</p><p>- ${esc(business)} sales agent on Exchangent</p>`;
  return { to: [email], subject: `Sold: ${title}, ${total}`, text, html, idempotencyKey: `exchangent-sale-${orderId}` };
}

/** The business profile fields the sale email needs, from a get_business result. */
export function businessFromResult(raw: unknown): { name: string | null; ownerEmail: string | null } {
  const top = rec(raw);
  const b = rec(top.business ?? top);
  const email = b.owner_email ?? top.owner_email;
  return { name: typeof b.name === "string" ? b.name : null, ownerEmail: typeof email === "string" && email ? email : null };
}

/**
 * order.confirmed -> one "Sold" email to the business owner. Sent from the seller's own mailbox when it has
 * one, else from the buyer agent's (the platform mailbox). Never throws: the event is acked either way.
 */
export class SaleNotifier {
  #sent = new Set<string>();
  transport: Transport;
  mcpFor: (agent: Agent) => Promise<McpToolClient>;
  platform: () => Agent;

  constructor({ transport, mcpFor, platform }: { transport: Transport; mcpFor: (agent: Agent) => Promise<McpToolClient>; platform: () => Agent }) {
    this.transport = transport;
    this.mcpFor = mcpFor;
    this.platform = platform;
  }

  async onOrder(seller: SellerAgent, event: WorkerEvent): Promise<void> {
    const p = event.payload || {};
    const orderId = p.order_id;
    if (!orderId || this.#sent.has(orderId)) return;
    try {
      const mcp = await this.mcpFor(seller);
      const biz = businessFromResult(await mcp.call("get_business", {}));
      if (!biz.ownerEmail) return log.info("sale email skipped: business owner has no email on file", { seller: seller.name, order: short(orderId) });
      const message = saleEmail({
        email: biz.ownerEmail,
        business: biz.name || seller.name,
        title: String(p.title || "an order"),
        totalCents: Number(p.total_cents),
        orderId,
      });
      this.#sent.add(orderId);
      let from: Agent = this.transport.hasMailbox?.(seller) === false ? this.platform() : seller;
      try {
        await this.transport.email(from, message);
      } catch (err) {
        if (from === seller) {
          // No identity for the seller after all (e.g. the cap): send from the platform mailbox instead.
          from = this.platform();
          log.warn("sale email: seller has no mailbox, using the platform mailbox", { seller: seller.name, error: (err as Error).message });
          await this.transport.email(from, message);
        } else throw err;
      }
      log.info("sale email sent", { seller: seller.name, from: from.id, order: short(orderId), total_cents: p.total_cents });
    } catch (err) {
      this.#sent.delete(orderId);
      log.error("sale email failed", { seller: seller.name, order: short(orderId), error: (err as Error).message });
    }
  }
}

/** Build the buyer's "Order confirmed" email (doc/hardening-contract.md: Primitive is off, the buyer agent sends it). */
export function orderEmail({ email, seller, title, totalCents, orderId }: { email: string; seller: string; title: string; totalCents: number; orderId: string }): EmailMessage {
  const total = money(totalCents);
  const text = [
    `Your order "${title}" is confirmed and paid.`,
    "",
    `Seller: ${seller}`,
    `Total paid, delivered: ${total}`,
    `Order: ${orderId}`,
    "",
    "Payment went through Stripe (test mode). The seller has been told to fulfil it.",
    "",
    "- Exchangent buyer agent",
  ].join("\n");
  const html =
    `<p>Your order <b>${esc(title)}</b> is confirmed and paid.</p>` +
    `<table><tr><td>Seller</td><td><b>${esc(seller)}</b></td></tr><tr><td>Total paid, delivered</td><td><b>${esc(total)}</b></td></tr>` +
    `<tr><td>Order</td><td><code>${esc(orderId)}</code></td></tr></table>` +
    `<p>Payment went through Stripe (test mode). The seller has been told to fulfil it.</p><p>- Exchangent buyer agent</p>`;
  return { to: [email], subject: `Order confirmed: ${seller}, ${total}`, text, html, idempotencyKey: `exchangent-order-${orderId}` };
}

/**
 * order.confirmed to the buyer -> one "Order confirmed" email, from the buyer agent's mailbox, to the address on the
 * order (get_buy_order buyer_email, as for the deal email). Never throws: the event is acked either way.
 */
export class OrderNotifier {
  #sent = new Set<string>();
  transport: Transport;
  mcpFor: (agent: Agent) => Promise<McpToolClient>;

  constructor({ transport, mcpFor }: { transport: Transport; mcpFor: (agent: Agent) => Promise<McpToolClient> }) {
    this.transport = transport;
    this.mcpFor = mcpFor;
  }

  async onOrder(buyer: Agent, event: WorkerEvent): Promise<void> {
    const p = event.payload || {};
    const orderId = p.order_id;
    const requestId = p.request_id || event.route?.request_id;
    if (!orderId || !requestId || this.#sent.has(orderId)) return;
    try {
      const mcp = await this.mcpFor(buyer);
      const o = rec(rec(await mcp.call("get_buy_order", { request_id: requestId })));
      const order = rec(o.request ?? o.buy_order ?? o);
      const email = typeof order.buyer_email === "string" && order.buyer_email ? order.buyer_email : null;
      if (!email) return log.info("order email skipped: buyer has no email on file", { order: short(orderId) });
      this.#sent.add(orderId);
      await this.transport.email(buyer, orderEmail({
        email,
        seller: String(p.seller_name || "the seller"),
        title: String(p.title || order.title || "your order"),
        totalCents: Number(p.total_cents),
        orderId,
      }));
      log.info("order email sent", { order: short(orderId), total_cents: p.total_cents });
    } catch (err) {
      this.#sent.delete(orderId);
      log.error("order email failed", { order: short(orderId), error: (err as Error).message });
    }
  }
}
