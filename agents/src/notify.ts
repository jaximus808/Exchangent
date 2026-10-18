// "Deal reached" email: when the buyer agent is ready to reserve, it tells the human who placed the order,
// from its own Inkbox mailbox (TRANSPORT=inkbox) or as a log line (TRANSPORT=local). The numbers in the email
// are re-read from get_buy_order, never taken from the turn result. buyer_email is only in the buyer agent's
// view of an order (backend buyer_agent scope); a demo buyer without an account has none, so nothing is sent.

import type { Agent } from "./agents.ts";
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
    subject: `Deal reached: ${d.seller}, ${total}`,
    text,
    html,
    idempotencyKey: `exchangent-deal-${d.requestId}`,
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

/** Sends at most one "deal reached" email per order per runner process (and the key dedupes across restarts). */
export class DealNotifier {
  #sent = new Set<string>();
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
    if (agent.role !== "buyer" || !offerId || !requestId || this.#sent.has(requestId)) return;
    try {
      const mcp = await this.mcpFor(agent);
      const deal = dealFromOrder(await mcp.call("get_buy_order", { request_id: requestId }), offerId);
      if (!deal) return log.warn("deal email skipped: offer not found on the order", { request: short(requestId), offer: short(offerId) });
      if (!deal.email) return log.info("deal email skipped: buyer has no email on file", { request: short(requestId) });
      this.#sent.add(requestId);
      await this.transport.email(agent, dealEmail({ ...deal, email: deal.email, requestId }));
      log.info("deal email sent", { request: short(requestId), seller: deal.seller, total_cents: deal.totalCents });
    } catch (err) {
      this.#sent.delete(requestId);
      log.error("deal email failed", { request: short(requestId), error: (err as Error).message });
    }
  }
}
