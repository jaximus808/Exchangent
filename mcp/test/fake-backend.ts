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
} as const;

type Reply = { status: number; body: unknown };
const ok = (data: unknown, status = 200): Reply => ({ status, body: { data } });
const fail = (status: number, code: string, message: string, next_action: string): Reply => ({
  status,
  body: { error: { code, message, next_action } },
});

function route(method: string, path: string, body: any): Reply {
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
  if (method === "GET" && path === `/api/v1/buy-requests/${IDS.request}/offers`) {
    return ok([{ offer_id: IDS.offer, session_id: IDS.session, seller_name: "Mission Desk Co", total_cents: 52000, delivery_cents: 2000 }]);
  }
  let m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/(offers|counters|decline)$/);
  if (m && method === "POST") {
    const [, sid, action] = m;
    if (sid === IDS.staleSession || body?.expected_version === 999) {
      return fail(409, "stale_offer", "Session version changed.", "reread_session");
    }
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
  if (method === "POST" && path === `/api/v1/offers/${IDS.offer}/reservations`) {
    return ok({ id: IDS.reservation, offer_id: IDS.offer, status: "held", total_cents: 52000, currency: "usd" });
  }
  if (method === "POST" && path === `/api/v1/reservations/${IDS.reservation}/checkout`) {
    return ok({ reservation_id: IDS.reservation, session_id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" });
  }
  if (method === "GET" && path === `/api/v1/reservations/${IDS.reservation}`) {
    return ok({ reservation_id: IDS.reservation, status: "consumed", total_cents: 52000, currency: "usd", order: { id: "o-1", status: "confirmed" } });
  }
  return fail(404, "not_found", "Not found.", "check_id");
}

export interface FakeBackend {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeBackend(): Promise<FakeBackend> {
  const requests: RecordedRequest[] = [];
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
    if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) reply = fail(401, "unauthorized", "Missing bearer token.", "authenticate");
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
