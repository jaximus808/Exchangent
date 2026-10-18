/**
 * Tiny in-memory stand-in for the Exchangent backend (doc/negotiation-contract.md),
 * used only by the MCP tests. Returns canned data in the `{ data }` /
 * `{ error: { code, message, next_action } }` envelope and records every request
 * so tests can assert what the MCP server forwarded.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export const IDS = {
  request: "11111111-1111-4111-8111-111111111111",
  session: "22222222-2222-4222-8222-222222222222",
  staleSession: "33333333-3333-4333-8333-333333333333",
  offer: "44444444-4444-4444-8444-444444444444",
  reservation: "55555555-5555-4555-8555-555555555555",
  seller: "66666666-6666-4666-8666-666666666666",
  inventory: "77777777-7777-4777-8777-777777777777",
  order: "88888888-8888-4888-8888-888888888888",
  case: "99999999-9999-4999-8999-999999999999",
} as const;

type Reply = { status: number; body: unknown };
const ok = (data: unknown, status = 200): Reply => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, next_action: string): Reply => ({
  status,
  body: { error: { code, message, next_action } },
});

function route(method: string, path: string, body: any): Reply {
  if (method === "POST" && path === "/api/v1/buy-requests" && body?.title === "No match") {
    return ok({ request_id: IDS.request, status: "negotiating", sessions: [] }, 201);
  }
  if (method === "POST" && path === "/api/v1/buy-requests") {
    return ok({
      request_id: IDS.request,
      status: "negotiating",
      sessions: [{ session_id: IDS.session, seller_id: IDS.seller, seller_name: "Mission Desk Co" }],
    }, 201);
  }
  if (method === "GET" && path === `/api/v1/buy-requests/${IDS.request}`) {
    return ok({
      request_id: IDS.request,
      status: "negotiating",
      title: "Desk + chair",
      budget_cents: 60000,
      sessions: [{ session_id: IDS.session, status: "open", turn: "buyer", version: 2, rounds: 1, current_offer: { offer_id: IDS.offer, total_cents: 52000 } }],
    });
  }
  if (method === "GET" && path === `/api/v1/buy-requests/${IDS.request}/conversation`) {
    return ok({
      request_id: IDS.request,
      title: "Desk + chair",
      status: "negotiating",
      delegate_negotiation: true,
      sessions: [{
        session_id: IDS.session, seller_id: IDS.seller, seller_name: "Mission Desk Co", status: "open", turn: "seller", rounds: 1,
        seller_agent: true, seller_handle: "exchangent-mission-desk-co", opened_at: "2026-10-18T04:00:00Z",
        messages: [
          { kind: "opened", by: "platform", at: "2026-10-18T04:00:00Z", delivery: { transport: "inkbox", from_handle: "exchangent-buyer", to_handle: "exchangent-mission-desk-co", message_id: "aaaaaaaa-0000-4000-8000-000000000001", context_id: "ctx-1", delivered_at: "2026-10-18T04:00:01Z" } },
          { kind: "offer", by: "seller", total_cents: 52000, note: "Solid oak, delivered tomorrow.", version: 1, offer_id: IDS.offer, at: "2026-10-18T04:00:05Z", delivery: { transport: "inkbox", from_handle: "exchangent-mission-desk-co", to_handle: "exchangent-buyer", message_id: "aaaaaaaa-0000-4000-8000-000000000002", context_id: "ctx-1", delivered_at: "2026-10-18T04:00:06Z" } },
          { kind: "counter", by: "buyer", total_cents: 45000, note: "Could you do $450?", version: 2, at: "2026-10-18T04:00:09Z" },
        ],
      }],
    });
  }
  if (method === "GET" && path === `/api/v1/buy-requests/${IDS.request}/offers`) {
    return ok([{ offer_id: IDS.offer, session_id: IDS.session, seller_name: "Mission Desk Co", total_cents: 52000, delivery_cents: 2000 }]);
  }
  let m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/(offers|counters|decline)$/);
  if (m && method === "POST") {
    const [, sid, action] = m;
    if (sid === IDS.staleSession || body?.expected_version === 999) {
      return fail(409, "stale_offer", "Session version changed.", "reread_session");
    }
    if (body?.expected_version === 777) return fail(409, "round_limit", "Round limit reached.", "Stop negotiating this session.");
    if (action === "offers") return ok({ offer_id: IDS.offer, version: 2, total_cents: 52000, session_version: 3 }, 201);
    if (action === "counters") return ok({ counter_id: "c-1", session_version: 3 }, 201);
    return ok({ session_id: sid, status: "declined" });
  }
  m = path.match(/^\/api\/v1\/sessions\/([^/]+)$/);
  if (m && method === "GET") {
    return ok({ session_id: m[1], status: "open", turn: "seller", version: 2, rounds: 1, requirements: { region: "san_francisco" }, history: [] });
  }
  if (method === "GET" && path === "/api/v1/seller/sessions") {
    return ok([{ session_id: IDS.session, title: "Desk + chair", turn: "seller", version: 0, rounds: 0 }]);
  }
  if (method === "GET" && path === "/api/v1/seller/inventory") {
    return ok([{ inventory_id: IDS.inventory, title: "Oak desk", category: "desk", list_cents: 45000, floor_cents: 38000, available: 3, attributes: { width_in: 46 } }]);
  }
  const business = { seller_id: IDS.seller, name: "Hayes Valley Desks", service_area: "san_francisco", delivery_cents: 1500, delivery_days: 2, delegate_negotiation: true, enabled: true, agent_handle: null, created_at: "2026-10-18T00:00:00Z", owner_email: "owner@example.com" };
  if (method === "POST" && path === "/api/v1/businesses") {
    if (String(body?.name).toLowerCase() === "bay desk co") return fail(409, "business_name_taken", "That business name is taken.", "Choose another name.");
    return ok({ business: { ...business, name: body?.name ?? business.name }, next: `Reconnect Exchangent in your assistant and choose ${body?.name} to manage it.` }, 201);
  }
  if (method === "GET" && path === "/api/v1/seller/business") return ok(business);
  if (method === "PATCH" && path === "/api/v1/seller/business") return ok({ ...business, ...body });
  if (method === "POST" && path === "/api/v1/seller/inventory") {
    return ok({ inventory_id: IDS.inventory, sku: body?.sku ?? "walnut-desk-46in", ...body });
  }
  if (method === "POST" && path === `/api/v1/offers/${IDS.offer}/reservations`) {
    return ok({ id: IDS.reservation, offer_id: IDS.offer, status: "held", total_cents: 52000, currency: "usd" });
  }
  if (method === "POST" && path === `/api/v1/reservations/${IDS.reservation}/checkout`) {
    return ok({ reservation_id: IDS.reservation, session_id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  }
  if (method === "GET" && path === `/api/v1/reservations/${IDS.reservation}`) {
    return ok({ reservation_id: IDS.reservation, status: "consumed", total_cents: 52000, currency: "usd", order: { id: "o-1", status: "confirmed" } });
  }
  // Orders and problem cases (doc/resolution-contract.md). The buyer order *list* route is
  // deliberately absent, to exercise the "feature not enabled yet" hint.
  const theCase = {
    case_id: IDS.case, order_id: IDS.order, type: "damaged", status: "open", turn: "seller", version: 1, rounds: 0, opened_by: "buyer",
    description: "Scratch across the desktop.", evidence: [{ kind: "photo", ref: "https://example.com/scratch.jpg", by: "buyer" }],
    moves: [{ by: "buyer", action: "open", remedy: { kind: "keep_with_discount", amount_cents: 9000 }, note: "Happy to keep it for $90 back.", version: 1, created_at: "2026-10-18T05:00:00Z" }],
  };
  if (method === "GET" && path === `/api/v1/orders/${IDS.order}`) {
    return ok({
      order_id: IDS.order, status: "delivered", title: "Desk + chair", seller_name: "Mission Desk Co", total_cents: 30000, refunded_cents: 0,
      carrier: "Local courier", tracking: "LC-1", shipped_at: "2026-10-18T04:30:00Z", delivered_at: "2026-10-18T04:45:00Z",
      delivery_evidence: { source: "simulated", at: "2026-10-18T04:45:00Z" }, items: [{ id: "ri-1", title: "Oak desk", quantity: 1, unit_cents: 15500 }],
      cases: [theCase], refunds: [],
    });
  }
  if (method === "POST" && path === `/api/v1/orders/${IDS.order}/cases`) return ok({ ...theCase, refunds_to_execute: undefined }, 201);
  if (method === "GET" && path === `/api/v1/cases/${IDS.case}`) return ok(theCase);
  if (method === "POST" && path === `/api/v1/cases/${IDS.case}/respond`) {
    if (body?.expected_version !== 1) return fail(409, "stale_offer", "Case version changed.", "Re-read the case.");
    return ok({ ...theCase, status: "resolved", version: 2, resolution: { kind: "keep_with_discount", amount_cents: 6000, how: "agreed" }, refunds: [{ amount_cents: 6000, status: "succeeded" }] });
  }
  if (method === "POST" && path === `/api/v1/seller/orders/${IDS.order}/ship`) return ok({ order_id: IDS.order, status: "shipped", carrier: body?.carrier, tracking: body?.tracking });
  if (method === "PUT" && path === "/api/v1/seller/policy") return ok({ seller_id: IDS.seller, max_auto_partial_refund_pct: 15, ...body });
  return fail(404, "not_found", "Not found.", "check_id");
}

export interface FakeBackend {
  url: string;
  requests: RecordedRequest[];
  /** Make the backend answer 401 for this bearer token from now on (a revoked connector grant). */
  revoke(token: string): void;
  close(): Promise<void>;
}

/**
 * `GET /me` for the principal behind a bearer token (doc/oauth-contract.md).
 * Connector tokens (`exc_…`) containing "seller" act for IDS.seller; other
 * `exc_` tokens act for a buyer.
 */
function me(token: string): Reply {
  if (token.startsWith("exc_")) {
    const seller = token.includes("seller");
    return ok({
      kind: "connector",
      scope: seller ? "seller" : "buyer",
      actor_id: "a0000000-0000-4000-8000-00000000000a",
      seller_id: seller ? IDS.seller : null,
      client_id: "exchangent-mcp-test-client",
    });
  }
  return ok({ actor_id: "a0000000-0000-4000-8000-0000000000de", kind: "buyer", scopes: null, request_id: null, seller_id: null });
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const requests: RecordedRequest[] = [];
  const revoked = new Set<string>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    let body: unknown = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? "", path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    let reply: Reply;
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!token) reply = fail(401, "unauthorized", "Missing bearer token.", "authenticate");
    else if (revoked.has(token)) reply = fail(401, "unauthorized", "Token revoked or expired.", "authenticate");
    else if (req.method === "GET" && url.pathname === "/api/v1/me") reply = me(token);
    else if (req.method === "POST" && !req.headers["idempotency-key"]) reply = fail(400, "invalid_input", "Idempotency-Key required.", "retry_with_key");
    else reply = route(req.method ?? "", url.pathname, body);
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    revoke: (token) => void revoked.add(token),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
