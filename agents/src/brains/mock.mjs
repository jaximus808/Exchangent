// Scripted brain: zero model tokens. Every turn re-reads state through MCP; numbers in the inbound
// message are never used (only its IDs). Tool names follow doc/negotiation-contract.md.

import { isToolError, toolErrorCode } from "../mcp.mjs";
import { logger, money } from "../log.mjs";

const log = logger("brain:mock");

export const CONCESSION = 0.05; // seller gives 5% per round, never below floor
// `rounds` comes from the backend and counts seller offers in the session.
export const BUYER_STOP_ROUND = 3; // from round 3 on, any offer <= budget is acceptable
export const BUYER_MAX_ROUNDS = 8; // safety valve: decline a seller that will not converge

const SESSION_STATUSES = new Set(["open", "declined", "closed"]);

// ---------- normalizers (tolerant of the MCP server's exact result shape) ----------

function arr(x) {
  return Array.isArray(x) ? x : [];
}

/** Seller view of a session from get_negotiation. */
export function normalizeNegotiation(raw) {
  const s = raw?.session || raw?.negotiation || raw || {};
  const history = arr(s.history);
  const offers = s.offers ? arr(s.offers) : history.filter((h) => h.offer_id || /offer/.test(h.type || h.kind || ""));
  const counters = s.counters ? arr(s.counters) : history.filter((h) => h.counter_id || /counter/.test(h.type || h.kind || ""));
  // The tool envelope also has a `status` ("ok"/"error"); only treat it as the session status if it is one.
  const statusCandidates = [s.session_status, raw?.session_status, s.status, raw?.session?.status];
  const sessionStatus = statusCandidates.find((v) => SESSION_STATUSES.has(v)) || "open";
  return {
    sessionId: s.session_id || s.id,
    requestId: s.request_id || s.request?.id || s.request?.request_id,
    status: sessionStatus,
    turn: s.turn,
    version: s.version ?? s.session_version ?? 0,
    rounds: s.rounds ?? 0,
    requirements: s.requirements || s.request?.requirements || {},
    deliveryCents: s.delivery_cents ?? s.seller?.delivery_cents,
    offers,
    counters,
    latestCounter: s.latest_counter || counters.at(-1) || null,
    latestOffer: s.latest_offer || s.current_offer || offers.at(-1) || null,
  };
}

export function normalizeInventory(raw) {
  const list = Array.isArray(raw) ? raw : raw?.inventory || raw?.items || raw?.data || [];
  return arr(list).map((i) => ({
    inventoryId: i.inventory_id || i.id,
    title: i.title || i.sku || "item",
    category: i.category,
    attributes: i.attributes || {},
    listCents: Number(i.list_cents ?? i.price_cents),
    floorCents: Number(i.floor_cents ?? i.list_cents),
    available: typeof i.available === "boolean" ? (i.available ? 1 : 0) : Number(i.available ?? i.quantity ?? 1),
  }));
}

/** Buyer view from get_buy_order. */
export function normalizeOrder(raw) {
  const o = raw?.request || raw?.buy_order || raw || {};
  const sessions = arr(o.sessions).map((s) => {
    const offer = s.current_offer || s.latest_offer || null;
    const counter = s.latest_counter || null;
    return {
      sessionId: s.session_id || s.id,
      sellerName: s.seller_name || s.seller?.name || s.seller_id,
      status: SESSION_STATUSES.has(s.status) ? s.status : s.session_status || "open",
      turn: s.turn,
      version: s.version ?? 0,
      rounds: s.rounds ?? (offer ? 1 : 0), // backend: number of seller offers in the session
      offer: offer ? { offerId: offer.offer_id || offer.id, totalCents: Number(offer.total_cents) } : null,
      counter: counter ? { counterId: counter.counter_id || counter.id, totalCents: Number(counter.total_cents) } : null,
    };
  });
  const budget = o.budget_cents ?? null;
  return {
    requestId: o.request_id || o.id,
    budgetCents: budget,
    targetCents: o.target_cents ?? (budget ? Math.round(budget * 0.8) : null),
    sessions,
  };
}

// ---------- seller pricing ----------

function satisfies(req, item) {
  if (req.category && item.category !== req.category) return false;
  for (const [k, v] of Object.entries(req)) {
    if (k === "category" || k === "quantity") continue;
    if (k.startsWith("max_")) {
      const a = item.attributes[k.slice(4)];
      if (a === undefined || Number(a) > Number(v)) return false;
    } else if (k.startsWith("min_")) {
      const a = item.attributes[k.slice(4)];
      if (a === undefined || Number(a) < Number(v)) return false;
    } else if (typeof v === "boolean") {
      if (Boolean(item.attributes[k]) !== v) return false;
    } else if (item.attributes[k] !== v) {
      return false;
    }
  }
  return true;
}

/** Cheapest in-stock item per requirement line (desk satisfying width, chair, ...). null if any line is unmet. */
export function pickBundle(inventory, requirements) {
  const lines = arr(requirements?.items).length ? requirements.items : [{ category: "desk" }, { category: "chair" }];
  const bundle = [];
  for (const req of lines) {
    const quantity = Number(req.quantity || 1);
    const used = new Set(bundle.map((b) => b.inventoryId));
    const match = inventory
      .filter((i) => !used.has(i.inventoryId) && i.available >= quantity && satisfies(req, i))
      .sort((a, b) => a.listCents - b.listCents)[0];
    if (!match) return null;
    bundle.push({ ...match, quantity });
  }
  return bundle;
}

export function bundleMinItemsCents(bundle) {
  return bundle.reduce((s, b) => s + b.floorCents * b.quantity, 0);
}

/** Split an items total across lines: every line at least its floor, surplus weighted by list-floor headroom. */
export function allocateAtTotal(bundle, itemsTotalCents) {
  const floors = bundle.map((b) => b.floorCents * b.quantity);
  const surplus = itemsTotalCents - floors.reduce((a, b) => a + b, 0);
  if (surplus < 0) throw new Error("allocation below floor");
  let weights = bundle.map((b) => Math.max(0, b.listCents - b.floorCents) * b.quantity);
  if (!weights.some(Boolean)) weights = bundle.map(() => 1);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const lineTotals = floors.map((f, i) => f + Math.floor((surplus * weights[i]) / wsum));
  const lines = bundle.map((b, i) => ({ inventory_id: b.inventoryId, quantity: b.quantity, unit_cents: Math.floor(lineTotals[i] / b.quantity) }));
  // Put the rounding remainder on a quantity-1 line so the total is exact (lines with qty > 1 may round down).
  const single = lines.findLastIndex((l) => l.quantity === 1);
  const remainder = itemsTotalCents - lines.reduce((s, l) => s + l.unit_cents * l.quantity, 0);
  if (single >= 0) lines[single].unit_cents += remainder;
  return lines;
}

/** Next seller price per line: list on the first offer, then 5% below the previous unit price, floored. */
export function concedeLines(bundle, previousOffer, priorOfferCount) {
  const prevItems = arr(previousOffer?.items);
  return bundle.map((b) => {
    const prev = prevItems.find((p) => (p.inventory_id || p.id) === b.inventoryId)?.unit_cents;
    const base = prev !== undefined ? Number(prev) : priorOfferCount > 0 ? b.listCents * (1 - CONCESSION) ** (priorOfferCount - 1) : null;
    const unit = base === null ? b.listCents : Math.round(base * (1 - CONCESSION));
    return { inventory_id: b.inventoryId, quantity: b.quantity, unit_cents: Math.max(b.floorCents, unit) };
  });
}

const sumLines = (lines, delivery) => lines.reduce((s, l) => s + l.unit_cents * l.quantity, 0) + delivery;

/**
 * Decide the seller's move from MCP state only. Returns { action: "offer", lines, deliveryCents, note, reason }
 * or { action: "decline", reason }.
 */
export function decideSeller(neg, inventory) {
  const bundle = pickBundle(inventory, neg.requirements);
  if (!bundle) return { action: "decline", reason: "No in-stock items meet the requirements." };
  const deliveryCents = Number(neg.deliveryCents ?? 0);
  const minTotal = bundleMinItemsCents(bundle) + deliveryCents;
  const counter = neg.latestCounter;
  const counterTotal = counter ? Number(counter.total_cents) : null;
  if (counter && counterTotal >= minTotal) {
    return {
      action: "offer",
      lines: allocateAtTotal(bundle, counterTotal - deliveryCents),
      deliveryCents,
      note: "We can do your price. Same bundle, same delivery.",
      reason: "meets counter",
    };
  }
  const priorOffers = neg.offers.length;
  if (!priorOffers) {
    return { action: "offer", lines: concedeLines(bundle, null, 0), deliveryCents, note: "Desk and chair bundle, delivered.", reason: "opens at list" };
  }
  const lines = concedeLines(bundle, neg.latestOffer, priorOffers);
  const atFloor = lines.every((l, i) => l.unit_cents === bundle[i].floorCents);
  return {
    action: "offer",
    lines,
    deliveryCents,
    note: atFloor ? "This is our best price on this bundle." : "We can come down a little.",
    reason: atFloor ? "best price" : "concedes 5%",
  };
}

/**
 * Decide the buyer's move from MCP state only.
 * Returns { action: "ready", session, offer } | { action: "counter", session, totalCents, reason } |
 *         { action: "decline", session } | { action: "wait", reason }.
 */
export function decideBuyer(order, sessionId) {
  const { targetCents, budgetCents } = order;
  const open = order.sessions.filter((s) => s.status === "open" && s.offer);
  const acceptable = open.filter((s) => {
    const t = s.offer.totalCents;
    if (targetCents !== null && t <= targetCents) return true;
    if (s.counter && t <= s.counter.totalCents) return true; // seller met our own counter
    if (s.rounds >= BUYER_STOP_ROUND && budgetCents !== null && t <= budgetCents) return true;
    return false;
  });
  if (acceptable.length) {
    const best = acceptable.sort((a, b) => a.offer.totalCents - b.offer.totalCents)[0];
    return { action: "ready", session: best, offer: best.offer };
  }
  const s = order.sessions.find((x) => x.sessionId === sessionId);
  if (!s || s.status !== "open") return { action: "wait", reason: "session not open" };
  if (s.turn && s.turn !== "buyer") return { action: "wait", reason: "not our turn" };
  if (!s.offer) return { action: "wait", reason: "no offer yet" };
  if (s.rounds >= BUYER_MAX_ROUNDS) return { action: "decline", session: s };
  let total = s.counter ? Math.round((s.counter.totalCents + s.offer.totalCents) / 2) : targetCents;
  if (budgetCents !== null) total = Math.min(total, budgetCents);
  total = Math.min(total, s.offer.totalCents - 1);
  return { action: "counter", session: s, totalCents: total, reason: s.counter ? "splits the difference" : "counters at target" };
}

// ---------- the brain ----------

export function createMockBrain({ mcpFor }) {
  const ready = new Map(); // request_id -> offer the buyer is ready to reserve
  const sessionRequest = new Map(); // session_id -> request_id (session.declined carries only session_id)

  async function sellerTurn(agent, event, attempt = 0) {
    const sessionId = event.payload?.session_id;
    if (event.kind === "session.declined") {
      log.info("buyer declined; nothing to do", { agent: agent.id, session: sessionId });
      return { action: "noop" };
    }
    const mcp = await mcpFor(agent);
    const negRaw = await mcp.call("get_negotiation", { session_id: sessionId });
    if (isToolError(negRaw)) return { action: "error", code: toolErrorCode(negRaw) };
    const neg = normalizeNegotiation(negRaw);
    if (neg.status !== "open") return log.info("session not open; skip", { agent: agent.id, session: sessionId, status: neg.status }), { action: "noop" };
    if (neg.turn && neg.turn !== "seller") return log.info("not our turn; skip", { agent: agent.id, session: sessionId }), { action: "noop" };
    const invRaw = await mcp.call("get_inventory", {});
    if (isToolError(invRaw)) return { action: "error", code: toolErrorCode(invRaw) };
    const inventory = normalizeInventory(invRaw);
    if (neg.deliveryCents === undefined && invRaw?.delivery_cents !== undefined) neg.deliveryCents = invRaw.delivery_cents;

    const move = decideSeller(neg, inventory);
    if (move.action === "decline") {
      const r = await mcp.call("decline_request", { session_id: sessionId, reason: move.reason });
      log.info("declines request", { agent: agent.id, session: sessionId, reason: move.reason });
      return { action: "decline", result: r };
    }
    const total = sumLines(move.lines, move.deliveryCents);
    const r = await mcp.call("make_offer", {
      session_id: sessionId,
      expected_version: neg.version,
      items: move.lines,
      delivery_cents: move.deliveryCents,
      note: move.note,
    });
    if (isToolError(r)) {
      const code = toolErrorCode(r);
      if (code === "stale_offer" && attempt === 0) return sellerTurn(agent, event, 1);
      log.warn("make_offer rejected", { agent: agent.id, session: sessionId, code, next: r.next });
      return { action: "error", code };
    }
    log.info(`OFFER ${move.reason}`, { agent: agent.id, session: sessionId, total_cents: r.total_cents ?? total, offer_id: r.offer_id });
    return { action: "offer", reason: move.reason, totalCents: r.total_cents ?? total, offerId: r.offer_id };
  }

  async function buyerTurn(agent, event, attempt = 0) {
    const sessionId = event.payload?.session_id;
    if (event.payload?.request_id && sessionId) sessionRequest.set(sessionId, event.payload.request_id);
    const requestId = event.payload?.request_id || sessionRequest.get(sessionId);
    if (event.kind === "session.declined") log.info("seller declined", { agent: agent.id, session: sessionId });
    if (!requestId) {
      log.warn("no request_id for event; cannot read the buy order", { agent: agent.id, kind: event.kind, session: sessionId });
      return { action: "noop" };
    }
    if (ready.has(requestId)) {
      log.info("already ready to reserve; ignoring", { agent: agent.id, offer_id: ready.get(requestId).offerId });
      return { action: "noop" };
    }
    const mcp = await mcpFor(agent);
    const raw = await mcp.call("get_buy_order", { request_id: requestId });
    if (isToolError(raw)) return { action: "error", code: toolErrorCode(raw) };
    const order = normalizeOrder(raw);
    const move = decideBuyer(order, sessionId);

    if (move.action === "ready") {
      ready.set(requestId, move.offer);
      log.info(`READY TO RESERVE: offer ${move.offer.offerId}`, {
        agent: agent.id,
        seller: move.session.sellerName,
        total_cents: move.offer.totalCents,
        session: move.session.sessionId,
        next: "human calls reserve_offer + get_checkout_link",
      });
      return { action: "ready", offerId: move.offer.offerId, totalCents: move.offer.totalCents, sessionId: move.session.sessionId };
    }
    if (move.action === "decline") {
      await mcp.call("decline_seller", { session_id: move.session.sessionId, reason: "We could not agree on a price." });
      log.info("declines seller after max rounds", { agent: agent.id, session: move.session.sessionId });
      return { action: "decline" };
    }
    if (move.action === "wait") {
      log.info(`waiting (${move.reason})`, { agent: agent.id, session: sessionId });
      return { action: "noop" };
    }
    const r = await mcp.call("counter_offer", {
      session_id: move.session.sessionId,
      expected_version: move.session.version,
      total_cents: move.totalCents,
      note: move.reason === "counters at target" ? "Thanks. Could you do better on the bundle?" : "Let's meet in the middle.",
    });
    if (isToolError(r)) {
      const code = toolErrorCode(r);
      if (code === "stale_offer" && attempt === 0) return buyerTurn(agent, event, 1);
      log.warn("counter_offer rejected", { agent: agent.id, session: sessionId, code, next: r.next });
      return { action: "error", code };
    }
    log.info(`COUNTER ${move.reason}`, { agent: agent.id, seller: move.session.sellerName, session: move.session.sessionId, total_cents: move.totalCents });
    return { action: "counter", totalCents: move.totalCents, reason: move.reason };
  }

  return {
    name: "mock",
    ready,
    async turn(agent, event) {
      return agent.role === "seller" ? sellerTurn(agent, event) : buyerTurn(agent, event);
    },
  };
}
