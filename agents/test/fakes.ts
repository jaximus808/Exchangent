// Test doubles: an in-memory market that follows doc/negotiation-contract.md semantics, a fake backend
// (worker endpoints over real HTTP) and a fake MCP server (real MCP Streamable HTTP via the official SDK).

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { EventKind, EventPayload, EventRoute, WorkerEvent } from "../src/backend.ts";
import type { Principals } from "../src/config.ts";
import type { Requirements } from "../src/mcp.ts";

export const REQUIREMENTS: Requirements = {
  region: "san_francisco",
  deliver_by: "2026-10-18",
  items: [
    { category: "desk", max_width_in: 48 },
    { category: "chair", ergonomic: true },
  ],
};

export interface InventoryRow {
  inventory_id: string;
  title: string;
  category: string;
  attributes: Record<string, unknown>;
  list_cents: number;
  floor_cents: number;
  available: number;
}

export interface FakeSeller {
  seller_id: string;
  name: string;
  token: string;
  delivery_cents: number;
  inventory: InventoryRow[];
  /** Self-serve business: not in the principals file; the runner mints its token with the worker token. */
  dynamic?: boolean;
  /** delegate_negotiation (default true). */
  delegated?: boolean;
  owner_email?: string | null;
}

export interface FakeRequest {
  request_id: string;
  buyer_id: string;
  title: string;
  requirements: Requirements;
  budget_cents: number;
  target_cents: number;
  status: string;
}

export interface FakeSession {
  session_id: string;
  request_id: string;
  seller_id: string;
  status: "open" | "declined" | "closed";
  turn: "seller" | "buyer";
  version: number;
  rounds: number;
  latest_offer_id: string | null;
  latest_counter_id: string | null;
}

export interface OfferItem {
  inventory_id: string;
  quantity: number;
  unit_cents: number;
}

export interface FakeOffer {
  offer_id: string;
  session_id: string;
  items: OfferItem[];
  delivery_cents: number;
  tax_cents: number;
  total_cents: number;
  note: string;
  version: number;
  created_at: string;
}

export interface FakeCounter {
  counter_id: string;
  session_id: string;
  buyer_id: string;
  responding_to_offer_id: string | null;
  total_cents: number;
  note: string;
  version: number;
  created_at: string;
}

export interface OutboxRow extends WorkerEvent {
  delivered: boolean;
}

export interface Principal {
  scope: "buyer" | "seller" | "worker";
  actor_id?: string;
  seller_id?: string;
}

/** Tool result envelope, as mcp/src/adapter.ts shapes it. */
export type FakeResult = { status: "ok" | "error"; next: string; [key: string]: unknown };

export interface ToolCall {
  token: string;
  scope: Principal["scope"] | undefined;
  name: string;
  args: Record<string, unknown> | undefined;
}

type SessionArgs = { session_id: string };
type MakeOfferArgs = { session_id: string; expected_version: number; items: OfferItem[]; delivery_cents: number; note: string };
type DeclineArgs = { session_id: string; reason: string };
type BuyOrderArgs = { request_id: string };
type CounterArgs = { session_id: string; expected_version: number; total_cents: number; note: string };
type ToolFn = (p: Principal, args: Record<string, unknown>) => FakeResult;

/** A business someone registered and stocked through MCP (doc/signup-contract.md). */
export const SELF_SERVE_SELLER: FakeSeller = {
  seller_id: "s-jaxon",
  name: "Jaxon's Desks",
  token: "tok-jaxon",
  delivery_cents: 1000,
  dynamic: true,
  delegated: true,
  owner_email: "owner@example.com",
  inventory: [
    { inventory_id: "jax-desk", title: "Walnut desk 44in", category: "desk", attributes: { width_in: 44 }, list_cents: 22000, floor_cents: 16000, available: 2 },
    { inventory_id: "jax-chair", title: "Task chair", category: "chair", attributes: { ergonomic: true }, list_cents: 14000, floor_cents: 9000, available: 2 },
  ],
};

export function createMarket({ tamperTotals = false, selfServe = false }: { tamperTotals?: boolean; selfServe?: boolean } = {}) {
  const buyer = { actor_id: "buyer-1", token: "tok-buyer" };
  const worker = { token: "tok-worker" };
  const sellers: FakeSeller[] = [
    {
      seller_id: "s-acme",
      name: "Acme Desks",
      token: "tok-acme",
      delivery_cents: 2000,
      inventory: [
        { inventory_id: "acme-desk-46", title: "Oak desk 46in", category: "desk", attributes: { width_in: 46 }, list_cents: 25000, floor_cents: 18000, available: 3 },
        { inventory_id: "acme-desk-60", title: "Wide desk 60in", category: "desk", attributes: { width_in: 60 }, list_cents: 20000, floor_cents: 15000, available: 2 },
        { inventory_id: "acme-chair", title: "Ergo chair", category: "chair", attributes: { ergonomic: true }, list_cents: 15000, floor_cents: 10000, available: 5 },
        { inventory_id: "acme-stool", title: "Stool", category: "chair", attributes: { ergonomic: false }, list_cents: 5000, floor_cents: 3000, available: 9 },
      ],
    },
    {
      seller_id: "s-bay",
      name: "Bay Office",
      token: "tok-bay",
      delivery_cents: 0,
      inventory: [
        { inventory_id: "bay-desk", title: "Standing desk 44in", category: "desk", attributes: { width_in: 44 }, list_cents: 30000, floor_cents: 26000, available: 1 },
        { inventory_id: "bay-chair", title: "Mesh chair", category: "chair", attributes: { ergonomic: true }, list_cents: 18000, floor_cents: 15000, available: 1 },
      ],
    },
  ];
  if (selfServe) sellers.push(structuredClone(SELF_SERVE_SELLER));
  const mints: string[] = [];

  const requests = new Map<string, FakeRequest>();
  const sessions = new Map<string, FakeSession>();
  const offers = new Map<string, FakeOffer>();
  const counters = new Map<string, FakeCounter>();
  const outbox: OutboxRow[] = [];
  const toolCalls: ToolCall[] = [];
  const acks: string[] = [];
  const registrations: Array<{ seller_id: string; agent_handle: unknown }> = [];
  let failAckOnce = new Set<string>();

  // Callers only pass ids of the sellers above.
  const sellerById = (id: string | undefined) => sellers.find((s) => s.seller_id === id)!;
  const now = () => new Date().toISOString();

  function principal(token: string): Principal | null {
    if (token === buyer.token) return { scope: "buyer", actor_id: buyer.actor_id };
    if (token === worker.token) return { scope: "worker" };
    const s = sellers.find((x) => x.token === token);
    return s ? { scope: "seller", seller_id: s.seller_id } : null;
  }

  function emit(kind: EventKind, payload: EventPayload, route: EventRoute) {
    // Like commerce_worker_events: route carries request_id and seller_id for every event.
    const request_id = payload.session_id ? sessions.get(payload.session_id)?.request_id : payload.request_id;
    const seller_delegated = sellerById(route.seller_id ?? sessions.get(payload.session_id ?? "")?.seller_id)?.delegated !== false;
    outbox.push({ id: randomUUID(), kind, created_at: now(), payload, route: { ...route, request_id, seller_delegated }, delivered: false });
  }

  /** The buyer paid for a reservation of this offer: like commerce_apply_payment's order.confirmed row. */
  function confirmOrder(offerId: string) {
    const o = offers.get(offerId)!;
    const s = sessions.get(o.session_id)!;
    const r = requests.get(s.request_id)!;
    r.status = "confirmed";
    const order_id = randomUUID();
    emit("order.confirmed", { order_id, reservation_id: randomUUID(), request_id: r.request_id, seller_id: s.seller_id, total_cents: o.total_cents, currency: "usd", title: r.title }, { to_role: "seller", seller_id: s.seller_id, buyer_id: r.buyer_id });
    return order_id;
  }

  /** POST /worker/sellers/:id/token: only for delegated businesses. */
  function mintSellerToken(sellerId: string): { status: number; body: unknown } {
    const s = sellers.find((x) => x.seller_id === sellerId);
    if (!s) return { status: 404, body: { error: { code: "seller_not_found", message: "no such seller" } } };
    if (s.delegated === false) return { status: 403, body: { error: { code: "not_delegated", message: "owner negotiates in chat" } } };
    mints.push(sellerId);
    return { status: 200, body: { data: { token: s.token, seller_id: s.seller_id, name: s.name, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(), agent_handle: null } } };
  }

  function createBuyOrder({ title, requirements, budget_cents, target_cents }: { title: string; requirements: Requirements; budget_cents: number; target_cents: number }) {
    const request_id = randomUUID();
    requests.set(request_id, { request_id, buyer_id: buyer.actor_id, title, requirements, budget_cents, target_cents, status: "open" });
    for (const s of sellers) {
      const session_id = randomUUID();
      sessions.set(session_id, { session_id, request_id, seller_id: s.seller_id, status: "open", turn: "seller", version: 0, rounds: 0, latest_offer_id: null, latest_counter_id: null });
      emit("session.opened", { session_id, request_id }, { to_role: "seller", seller_id: s.seller_id });
    }
    return request_id;
  }

  const err = (code: string, message: string): FakeResult => ({ status: "error", error: { code, message, next_action: null }, next: "Re-read the session and try again." });

  function sessionOffers(sid: string) {
    return [...offers.values()].filter((o) => o.session_id === sid);
  }
  function sessionCounters(sid: string) {
    return [...counters.values()].filter((c) => c.session_id === sid);
  }

  const tools = {
    // ---- seller ----
    get_negotiation(p: Principal, { session_id }: SessionArgs): FakeResult {
      // Mirrors backend commerce_session_state as shaped by mcp/ (status -> session_status, flattened).
      const s = sessions.get(session_id);
      if (!s || p.scope !== "seller" || s.seller_id !== p.seller_id) return err("forbidden", "not your session");
      const r = requests.get(s.request_id)!;
      const seller = sellerById(s.seller_id);
      const history = [
        ...sessionOffers(session_id).map((o) => ({ type: "offer", ...o })),
        ...sessionCounters(session_id).map(({ counter_id, total_cents, note, version, created_at, responding_to_offer_id }) => ({ type: "counter", counter_id, responding_to_offer_id, total_cents, note, version, created_at })),
      ].sort((a, b) => a.version - b.version);
      const counter = s.latest_counter_id && counters.get(s.latest_counter_id);
      return {
        status: "ok",
        session_id,
        request_id: s.request_id,
        seller_id: s.seller_id,
        seller_name: seller.name,
        seller: { service_area: "san_francisco", delivery_cents: seller.delivery_cents, delivery_days: 2 },
        session_status: s.status,
        turn: s.turn,
        version: s.version,
        rounds: s.rounds,
        current_offer: s.latest_offer_id ? offers.get(s.latest_offer_id) : null,
        latest_counter: counter ? { counter_id: counter.counter_id, total_cents: counter.total_cents, note: counter.note } : null,
        request: { request_id: r.request_id, title: r.title, requirements: r.requirements },
        history,
        next: s.turn === "seller" ? "Make an offer with make_offer." : "Wait for the buyer.",
      };
    },
    get_business(p: Principal): FakeResult {
      if (p.scope !== "seller") return err("forbidden", "seller only");
      const s = sellerById(p.seller_id);
      return { status: "ok", seller_id: s.seller_id, name: s.name, delegate_negotiation: s.delegated !== false, owner_email: s.owner_email ?? null, next: "" };
    },
    get_inventory(p: Principal): FakeResult {
      if (p.scope !== "seller") return err("forbidden", "seller only");
      return { status: "ok", inventory: sellerById(p.seller_id).inventory, next: "Pick items for make_offer." };
    },
    make_offer(p: Principal, { session_id, expected_version, items, delivery_cents, note }: MakeOfferArgs): FakeResult {
      const s = sessions.get(session_id);
      if (!s || p.scope !== "seller" || s.seller_id !== p.seller_id) return err("forbidden", "not your session");
      if (s.status !== "open") return err("session_closed", "closed");
      if (s.version !== expected_version) return err("stale_offer", "version mismatch");
      if (s.turn !== "seller") return err("not_your_turn", "buyer's turn");
      const inv = sellerById(p.seller_id).inventory;
      for (const it of items) {
        const row = inv.find((i) => i.inventory_id === it.inventory_id);
        if (!row) return err("invalid_input", "unknown item");
        if (it.unit_cents < row.floor_cents) return err("below_floor", "below floor");
        if (row.available < it.quantity) return err("out_of_stock", "stock");
      }
      const total_cents = items.reduce((a, i) => a + i.unit_cents * i.quantity, 0) + delivery_cents;
      const offer_id = randomUUID();
      s.version += 1;
      s.rounds += 1; // backend: rounds counts seller offers
      s.turn = "buyer";
      s.latest_offer_id = offer_id;
      offers.set(offer_id, { offer_id, session_id, items, delivery_cents, tax_cents: 0, total_cents, note, version: s.version, created_at: now() });
      emit("offer.created", { session_id, request_id: s.request_id, offer_id, total_cents: tamperTotals ? 1 : total_cents, note }, { to_role: "buyer", buyer_id: buyer.actor_id, seller_id: s.seller_id });
      return { status: "ok", offer_id, version: s.version, total_cents, session_version: s.version, next: "Wait for the buyer." };
    },
    decline_request(p: Principal, { session_id, reason }: DeclineArgs): FakeResult {
      const s = sessions.get(session_id);
      if (!s || s.seller_id !== p.seller_id) return err("forbidden", "not your session");
      s.status = "declined";
      emit("session.declined", { session_id }, { to_role: "buyer", buyer_id: buyer.actor_id, seller_id: s.seller_id });
      return { status: "ok", session_id, session_status: "declined", reason, next: "Done." };
    },
    // ---- buyer ----
    get_buy_order(p: Principal, { request_id }: BuyOrderArgs): FakeResult {
      const r = requests.get(request_id);
      if (!r || p.scope !== "buyer") return err("forbidden", "not your request");
      const list = [...sessions.values()].filter((s) => s.request_id === request_id);
      return {
        status: "ok",
        request_status: r.status,
        request_id,
        title: r.title,
        requirements: r.requirements,
        budget_cents: r.budget_cents,
        target_cents: r.target_cents,
        sessions: list.map((s) => {
          const o = s.latest_offer_id && offers.get(s.latest_offer_id);
          const c = s.latest_counter_id && counters.get(s.latest_counter_id);
          return {
            session_id: s.session_id,
            seller_id: s.seller_id,
            seller_name: sellerById(s.seller_id).name,
            status: s.status, // nested sessions keep `status`; only the top-level one is renamed by mcp/
            turn: s.turn,
            version: s.version,
            rounds: s.rounds,
            current_offer: o ? { offer_id: o.offer_id, total_cents: o.total_cents, note: o.note } : null,
            latest_counter: c ? { counter_id: c.counter_id, total_cents: c.total_cents } : null,
          };
        }),
        next: "Counter, decline or reserve.",
      };
    },
    counter_offer(p: Principal, { session_id, expected_version, total_cents, note }: CounterArgs): FakeResult {
      const s = sessions.get(session_id);
      if (!s || p.scope !== "buyer") return err("forbidden", "not your session");
      const r = requests.get(s.request_id)!;
      if (s.status !== "open") return err("session_closed", "closed");
      if (s.version !== expected_version) return err("stale_offer", "version mismatch");
      if (s.turn !== "buyer") return err("not_your_turn", "seller's turn");
      if (total_cents > r.budget_cents) return err("budget_exceeded", "over budget");
      const counter_id = randomUUID();
      s.version += 1;
      s.turn = "seller";
      s.latest_counter_id = counter_id;
      counters.set(counter_id, { counter_id, session_id, buyer_id: buyer.actor_id, responding_to_offer_id: s.latest_offer_id, total_cents, note, version: s.version, created_at: now() });
      emit("counter.created", { session_id, counter_id, total_cents: tamperTotals ? 1 : total_cents, note }, { to_role: "seller", seller_id: s.seller_id });
      return { status: "ok", counter_id, session_version: s.version, next: "Wait for the seller." };
    },
    decline_seller(p: Principal, { session_id, reason }: DeclineArgs): FakeResult {
      const s = sessions.get(session_id);
      if (!s || p.scope !== "buyer") return err("forbidden", "not your session");
      s.status = "declined";
      emit("session.declined", { session_id }, { to_role: "seller", seller_id: s.seller_id });
      return { status: "ok", session_id, session_status: "declined", reason, next: "Done." };
    },
  };

  function callTool(token: string, name: string, args: Record<string, unknown> | undefined): FakeResult {
    const p = principal(token);
    toolCalls.push({ token, scope: p?.scope, name, args });
    if (!p || p.scope === "worker") return err("unauthorized", "bad token");
    // Arguments arrive untyped over MCP; each fake tool reads the fields its real counterpart requires.
    const fn = tools[name as keyof typeof tools] as ToolFn | undefined;
    if (!fn) return err("invalid_input", `unknown tool ${name}`);
    return fn(p, args || {});
  }

  return {
    buyer,
    sellers,
    worker,
    requests,
    sessions,
    offers,
    counters,
    outbox,
    toolCalls,
    acks,
    registrations,
    mints,
    principal,
    createBuyOrder,
    confirmOrder,
    mintSellerToken,
    callTool,
    toolNames: Object.keys(tools),
    failAckOnce(id: string) {
      failAckOnce.add(id);
    },
    pending(limit = 20): WorkerEvent[] {
      return outbox.filter((e) => !e.delivered).slice(0, limit).map(({ delivered, ...e }) => e);
    },
    ack(id: string) {
      if (failAckOnce.has(id)) {
        failAckOnce.delete(id);
        return false;
      }
      const e = outbox.find((x) => x.id === id);
      if (e) e.delivered = true;
      acks.push(id);
      return true;
    },
    principalsJson(backendUrl: string): Principals {
      return {
        backend_url: backendUrl,
        buyer,
        sellers: sellers.filter((s) => !s.dynamic).map(({ seller_id, name, token }) => ({ seller_id, name, token })),
        worker,
      };
    },
  };
}

export type Market = ReturnType<typeof createMarket>;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : undefined;
}

/** Fake backend: only the worker endpoints the runner uses. */
export async function startFakeBackend(market: Market) {
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (market.principal(token)?.scope !== "worker") return send(401, { error: { code: "unauthorized", message: "worker token required", next_action: "" } });
    const url = new URL(req.url!, "http://x");
    if (req.method !== "GET" && !req.headers["idempotency-key"]) return send(400, { error: { code: "invalid_input", message: "Idempotency-Key required" } });
    let m: RegExpMatchArray | null;
    if (req.method === "GET" && url.pathname === "/api/v1/worker/events") {
      return send(200, { data: market.pending(Number(url.searchParams.get("limit") || 20)) });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/worker\/events\/([^/]+)\/ack$/))) {
      if (!market.ack(m[1])) return send(503, { error: { code: "unavailable", message: "simulated ack failure" } });
      return send(200, { data: { id: m[1], delivered: true } });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/worker\/sellers\/([^/]+)\/token$/))) {
      const r = market.mintSellerToken(m[1]);
      return send(r.status, r.body);
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/worker\/sellers\/([^/]+)\/token$/))) {
      const r = market.mintSellerToken(m[1]);
      return send(r.status, r.body);
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/worker\/sellers\/([^/]+)\/agent$/))) {
      const body = (await readBody(req)) as { agent_handle?: unknown };
      market.registrations.push({ seller_id: m[1], agent_handle: body.agent_handle });
      return send(200, { data: { seller_id: m[1], agent_handle: body.agent_handle } });
    }
    send(404, { error: { code: "not_found", message: url.pathname } });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Fake MCP server: real MCP Streamable HTTP (stateless), tools forward to the market with the caller's bearer token. */
export async function startFakeMcp(market: Market) {
  const authHeaders: string[] = [];
  const server = http.createServer(async (req, res) => {
    if (new URL(req.url!, "http://x").pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const auth = req.headers.authorization || "";
    authHeaders.push(auth);
    const token = auth.replace(/^Bearer /, "");
    if (!market.principal(token)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const mcp = new Server({ name: "fake-exchangent", version: "0.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: market.toolNames.map((name) => ({ name, inputSchema: { type: "object" as const } })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = market.callTool(token, request.params.name, request.params.arguments);
      // Same envelope as mcp/src/adapter.ts: structuredContent + JSON text, isError on errors.
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(result.status === "error" ? { isError: true } : {}) };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    authHeaders,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export async function waitFor(fn: () => unknown, timeoutMs = 10000, stepMs = 20): Promise<true> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
