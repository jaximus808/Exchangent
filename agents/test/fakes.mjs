// Test doubles: an in-memory market that follows doc/negotiation-contract.md semantics, a fake backend
// (worker endpoints over real HTTP) and a fake MCP server (real MCP Streamable HTTP via the official SDK).

import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const REQUIREMENTS = {
  region: "san_francisco",
  deliver_by: "2026-10-18",
  items: [
    { category: "desk", max_width_in: 48 },
    { category: "chair", ergonomic: true },
  ],
};

export function createMarket({ tamperTotals = false } = {}) {
  const buyer = { actor_id: "buyer-1", token: "tok-buyer" };
  const worker = { token: "tok-worker" };
  const sellers = [
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

  const requests = new Map();
  const sessions = new Map();
  const offers = new Map();
  const counters = new Map();
  const outbox = [];
  const toolCalls = [];
  const acks = [];
  const registrations = [];
  let failAckOnce = new Set();

  const sellerById = (id) => sellers.find((s) => s.seller_id === id);
  const now = () => new Date().toISOString();

  function principal(token) {
    if (token === buyer.token) return { scope: "buyer", actor_id: buyer.actor_id };
    if (token === worker.token) return { scope: "worker" };
    const s = sellers.find((x) => x.token === token);
    return s ? { scope: "seller", seller_id: s.seller_id } : null;
  }

  function emit(kind, payload, route) {
    // Like commerce_worker_events: route carries request_id and seller_id for every event.
    const request_id = sessions.get(payload.session_id)?.request_id;
    outbox.push({ id: randomUUID(), kind, created_at: now(), payload, route: { ...route, request_id }, delivered: false });
  }

  function createBuyOrder({ title, requirements, budget_cents, target_cents }) {
    const request_id = randomUUID();
    requests.set(request_id, { request_id, buyer_id: buyer.actor_id, title, requirements, budget_cents, target_cents, status: "open" });
    for (const s of sellers) {
      const session_id = randomUUID();
      sessions.set(session_id, { session_id, request_id, seller_id: s.seller_id, status: "open", turn: "seller", version: 0, rounds: 0, latest_offer_id: null, latest_counter_id: null });
      emit("session.opened", { session_id, request_id }, { to_role: "seller", seller_id: s.seller_id });
    }
    return request_id;
  }

  const err = (code, message) => ({ status: "error", error: { code, message, next_action: null }, next: "Re-read the session and try again." });

  function sessionOffers(sid) {
    return [...offers.values()].filter((o) => o.session_id === sid);
  }
  function sessionCounters(sid) {
    return [...counters.values()].filter((c) => c.session_id === sid);
  }

  const tools = {
    // ---- seller ----
    get_negotiation(p, { session_id }) {
      // Mirrors backend commerce_session_state as shaped by mcp/ (status -> session_status, flattened).
      const s = sessions.get(session_id);
      if (!s || p.scope !== "seller" || s.seller_id !== p.seller_id) return err("forbidden", "not your session");
      const r = requests.get(s.request_id);
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
    get_inventory(p) {
      if (p.scope !== "seller") return err("forbidden", "seller only");
      return { status: "ok", inventory: sellerById(p.seller_id).inventory, next: "Pick items for make_offer." };
    },
    make_offer(p, { session_id, expected_version, items, delivery_cents, note }) {
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
    decline_request(p, { session_id, reason }) {
      const s = sessions.get(session_id);
      if (!s || s.seller_id !== p.seller_id) return err("forbidden", "not your session");
      s.status = "declined";
      emit("session.declined", { session_id }, { to_role: "buyer", buyer_id: buyer.actor_id, seller_id: s.seller_id });
      return { status: "ok", session_id, session_status: "declined", reason, next: "Done." };
    },
    // ---- buyer ----
    get_buy_order(p, { request_id }) {
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
    counter_offer(p, { session_id, expected_version, total_cents, note }) {
      const s = sessions.get(session_id);
      if (!s || p.scope !== "buyer") return err("forbidden", "not your session");
      const r = requests.get(s.request_id);
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
    decline_seller(p, { session_id, reason }) {
      const s = sessions.get(session_id);
      if (!s || p.scope !== "buyer") return err("forbidden", "not your session");
      s.status = "declined";
      emit("session.declined", { session_id }, { to_role: "seller", seller_id: s.seller_id });
      return { status: "ok", session_id, session_status: "declined", reason, next: "Done." };
    },
  };

  function callTool(token, name, args) {
    const p = principal(token);
    toolCalls.push({ token, scope: p?.scope, name, args });
    if (!p || p.scope === "worker") return err("unauthorized", "bad token");
    const fn = tools[name];
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
    principal,
    createBuyOrder,
    callTool,
    toolNames: Object.keys(tools),
    failAckOnce(id) {
      failAckOnce.add(id);
    },
    pending(limit = 20) {
      return outbox.filter((e) => !e.delivered).slice(0, limit).map(({ delivered, ...e }) => e);
    },
    ack(id) {
      if (failAckOnce.has(id)) {
        failAckOnce.delete(id);
        return false;
      }
      const e = outbox.find((x) => x.id === id);
      if (e) e.delivered = true;
      acks.push(id);
      return true;
    },
    principalsJson(backendUrl) {
      return {
        backend_url: backendUrl,
        buyer,
        sellers: sellers.map(({ seller_id, name, token }) => ({ seller_id, name, token })),
        worker,
      };
    },
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function readBody(req) {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : undefined;
}

/** Fake backend: only the worker endpoints the runner uses. */
export async function startFakeBackend(market) {
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (market.principal(token)?.scope !== "worker") return send(401, { error: { code: "unauthorized", message: "worker token required", next_action: "" } });
    const url = new URL(req.url, "http://x");
    if (req.method !== "GET" && !req.headers["idempotency-key"]) return send(400, { error: { code: "invalid_input", message: "Idempotency-Key required" } });
    let m;
    if (req.method === "GET" && url.pathname === "/api/v1/worker/events") {
      return send(200, { data: market.pending(Number(url.searchParams.get("limit") || 20)) });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/worker\/events\/([^/]+)\/ack$/))) {
      if (!market.ack(m[1])) return send(503, { error: { code: "unavailable", message: "simulated ack failure" } });
      return send(200, { data: { id: m[1], delivered: true } });
    }
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/v1\/worker\/sellers\/([^/]+)\/agent$/))) {
      const body = await readBody(req);
      market.registrations.push({ seller_id: m[1], agent_handle: body.agent_handle });
      return send(200, { data: { seller_id: m[1], agent_handle: body.agent_handle } });
    }
    send(404, { error: { code: "not_found", message: url.pathname } });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Fake MCP server: real MCP Streamable HTTP (stateless), tools forward to the market with the caller's bearer token. */
export async function startFakeMcp(market) {
  const authHeaders = [];
  const server = http.createServer(async (req, res) => {
    if (new URL(req.url, "http://x").pathname !== "/mcp") {
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
      tools: market.toolNames.map((name) => ({ name, inputSchema: { type: "object" } })),
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = market.callTool(token, request.params.name, request.params.arguments);
      // Same envelope as mcp/src/adapter.ts: structuredContent + JSON text, isError on errors.
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, ...(result.status === "error" ? { isError: true } : {}) };
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
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

export async function waitFor(fn, timeoutMs = 10000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
