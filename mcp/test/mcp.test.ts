/**
 * End-to-end test: fake backend <- MCP server (mcp-use, Streamable HTTP) <- MCP client.
 * Run with `npm test` (Node >= 22.18 strips TypeScript types natively).
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IDS, startFakeBackend, type FakeBackend } from "./fake-backend.ts";

const EXPECTED_TOOLS = [
  "create_buy_order",
  "get_buy_order",
  "list_offers",
  "counter_offer",
  "decline_seller",
  "reserve_offer",
  "get_checkout_link",
  "get_reservation_status",
  "list_my_requests",
  "get_negotiation",
  "get_inventory",
  "make_offer",
  "decline_request",
  "whoami",
].sort();

let backend: FakeBackend;
let mcpUrl: string;
let closeServer: () => Promise<void>;
const clients: Client[] = [];

async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: "exchangent-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

type Structured = Record<string, any>;
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { result, sc: result.structuredContent as Structured };
}

before(async () => {
  backend = await startFakeBackend();
  process.env.EXCHANGENT_API_URL = backend.url;
  delete process.env.EXCHANGENT_TOKEN;
  const { default: server } = await import(new URL("../.mcp-use/build/index.js",import.meta.url).href);
  const { url } = await server.listen(0);
  mcpUrl = url;
  closeServer = () => server.close();
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await closeServer?.();
  await backend?.close();
});

describe("exchangent mcp server", () => {
  test("lists exactly the contract tools (plus whoami), each with an input schema", async () => {
    const client = await connect("buyer-token");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object", `${t.name} input schema`);
      assert.ok(t.description && t.description.length > 40, `${t.name} has a description`);
    }
    const counter = tools.find((t) => t.name === "counter_offer")!;
    assert.deepEqual([...(counter.inputSchema.required ?? [])].sort(), ["expected_version", "session_id", "total_cents"]);
  });

  test("eight tools expose distinct readable MCP App resources",async()=>{
    const client=await connect("buyer-token");
    const {tools}=await client.listTools();
    const bound=tools.filter(t=>!!(t._meta?.ui as {resourceUri?:string}|undefined)?.resourceUri);
    assert.equal(bound.length,8);
    const uris=bound.map(t=>(t._meta!.ui as {resourceUri:string}).resourceUri);
    assert.equal(new Set(uris).size,8);
    for(const uri of uris) {
      const resource=await client.readResource({uri});
      const content=resource.contents[0];
      assert.ok(content.mimeType?.startsWith('text/html'));
      assert.ok('text' in content && content.text.includes('<script'));
      assert.ok(!('text' in content && content.text.includes('rkcs_test_')));
    }
  });

  test("create_buy_order forwards the caller's bearer header, an idempotency key and the body", async () => {
    const client = await connect("buyer-token");
    backend.requests.length = 0;
    const { result, sc } = await call(client, "create_buy_order", {
      title: "Desk + chair",
      requirements: { region: "san_francisco", items: [{ category: "desk", max_width_in: 48 }, { category: "chair", ergonomic: true }] },
      budget_cents: 60000,
      target_cents: 50000,
    });
    assert.notEqual(result.isError, true);
    assert.equal(sc.status, "ok");
    assert.equal(sc.request_id, IDS.request);
    assert.equal(sc.request_status, "negotiating", "backend `status` renamed so the envelope status stays ok|error");
    assert.equal(sc.sessions.length, 1);
    assert.match(sc.next, /list_offers|get_buy_order/);

    const req = backend.requests.find((r) => r.path === "/api/v1/buy-requests");
    assert.ok(req, "backend received POST /buy-requests");
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Bearer buyer-token");
    assert.match(String(req.headers["idempotency-key"]), /^mcp:create_buy_order:new:[0-9a-f]{24}$/);
    assert.deepEqual(req.body, {
      title: "Desk + chair",
      requirements: { region: "san_francisco", items: [{ category: "desk", max_width_in: 48 }, { category: "chair", ergonomic: true }] },
      budget_cents: 60000,
      target_cents: 50000,
    });
  });

  test("make_offer maps a backend stale_offer error into a status:error tool result", async () => {
    const client = await connect("seller-token");
    const { result, sc } = await call(client, "make_offer", {
      session_id: IDS.staleSession,
      expected_version: 1,
      items: [{ inventory_id: IDS.inventory, quantity: 1, unit_cents: 42000 }],
      delivery_cents: 0,
      note: "Opening offer",
    });
    assert.equal(result.isError, true);
    assert.equal(sc.status, "error");
    assert.equal(sc.error.code, "stale_offer");
    assert.equal(sc.error.http_status, 409);
    assert.equal(sc.error.next_action, "reread_session");
    assert.match(sc.next, /get_negotiation/);
    const req = backend.requests.at(-1)!;
    assert.equal(req.headers.authorization, "Bearer seller-token");
    assert.ok(req.headers["idempotency-key"]);
  });

  test("retrying the same mutation reuses the idempotency key; a new version changes it", async () => {
    const client = await connect("buyer-token");
    backend.requests.length = 0;
    const args = { session_id: IDS.session, expected_version: 2, total_cents: 48000, note: "Meet me here?" };
    await call(client, "counter_offer", args);
    await call(client, "counter_offer", args);
    await call(client, "counter_offer", { ...args, expected_version: 4 });
    await call(client, "counter_offer", { ...args, idempotency_key: "explicit-key-123" });
    const keys = backend.requests.map((r) => r.headers["idempotency-key"]);
    assert.equal(keys.length, 4);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.equal(keys[3], "explicit-key-123");
    assert.deepEqual(backend.requests[0].body, { expected_version: 2, total_cents: 48000, note: "Meet me here?" });
  });

  test("money outputs carry a $ display string next to cents", async () => {
    const client = await connect("buyer-token");
    const { sc } = await call(client, "list_offers", { request_id: IDS.request });
    assert.equal(sc.status, "ok");
    assert.equal(sc.offers[0].total_cents, 52000);
    assert.equal(sc.offers[0].total_display, "$520.00");
    assert.equal(sc.offers[0].delivery_display, "$20.00");
  });

  test("buyer checkout flow: reserve -> checkout link -> status", async () => {
    const client = await connect("buyer-token");
    const reserve = await call(client, "reserve_offer", { offer_id: IDS.offer });
    assert.equal(reserve.sc.reservation_id, IDS.reservation);
    assert.equal(reserve.sc.reservation_status, "held");
    const link = await call(client, "get_checkout_link", { reservation_id: IDS.reservation });
    assert.equal(link.sc.checkout_url, "https://checkout.stripe.com/c/pay/cs_test_123");
    assert.equal(link.sc.checkout_session_id, "cs_test_123");
    const status = await call(client, "get_reservation_status", { reservation_id: IDS.reservation });
    assert.equal(status.sc.reservation_status, "consumed");
    assert.match(status.sc.next, /confirmed/);
  });

  test("seller reads: list_my_requests passes ?status=open, get_negotiation hints expected_version", async () => {
    const client = await connect("seller-token");
    backend.requests.length = 0;
    const list = await call(client, "list_my_requests", {});
    assert.equal(list.sc.sessions.length, 1);
    assert.deepEqual(backend.requests[0].query, { status: "open" });
    const neg = await call(client, "get_negotiation", { session_id: IDS.session });
    assert.equal(neg.sc.session_status, "open");
    assert.match(neg.sc.next, /make_offer with expected_version 2/);
    const inv = await call(client, "get_inventory", {});
    assert.equal(inv.sc.inventory[0].floor_display, "$380.00");
  });

  test("without an Authorization header, EXCHANGENT_TOKEN is used as fallback", async () => {
    const client = await connect();
    process.env.EXCHANGENT_TOKEN = "env-fallback-token";
    try {
      backend.requests.length = 0;
      const { sc } = await call(client, "get_buy_order", { request_id: IDS.request });
      assert.equal(sc.status, "ok");
      assert.equal(backend.requests[0].headers.authorization, "Bearer env-fallback-token");
    } finally {
      delete process.env.EXCHANGENT_TOKEN;
    }
  });

  test("without any credential, tools return an unauthorized error result (not an exception)", async () => {
    const client = await connect();
    backend.requests.length = 0;
    const { result, sc } = await call(client, "get_inventory", {});
    assert.equal(result.isError, true);
    assert.equal(sc.error.code, "unauthorized");
    assert.match(sc.next, /Authorization: Bearer/);
    assert.equal(backend.requests.length, 0, "no backend call without a token");
  });

  test("whoami in bearer mode reports the mode and the backend's /me for the forwarded token", async () => {
    const client = await connect("buyer-token");
    backend.requests.length = 0;
    const { result, sc } = await call(client, "whoami", {});
    assert.notEqual(result.isError, true);
    assert.equal(sc.auth_mode, "bearer");
    assert.equal(sc.actor_id, "a0000000-0000-4000-8000-0000000000de");
    assert.equal(backend.requests[0].path, "/api/v1/me");
    assert.equal(backend.requests[0].headers.authorization, "Bearer buyer-token");
    assert.ok(!JSON.stringify(result).includes("buyer-token"), "never echoes the token");
  });

  test("schema validation rejects dollars-as-floats for *_cents inputs", async () => {
    const client = await connect("buyer-token");
    const result = await client.callTool({ name: "counter_offer", arguments: { session_id: IDS.session, expected_version: 2, total_cents: 480.5 } });
    assert.equal(result.isError, true);
  });
});
