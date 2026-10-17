// MCP client for the Exchangent MCP server (mcp/, served at MCP_URL), authenticated as one agent.
// Uses the official @modelcontextprotocol/sdk client over Streamable HTTP with the agent's bearer token.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./log.ts";

const log = logger("mcp");

// ---------- tool results (mcp/src/adapter.ts + mcp/src/tools.ts) ----------

/** `error` object of a failed tool call (adapter.ts errorResult). */
export interface ToolErrorInfo {
  code?: string;
  message?: string;
  next_action?: string | null;
  http_status?: number;
}

/**
 * Normalized tools/call result. The contract is `{ status: "ok" | "error", ...data, next }`; parseToolResult
 * passes through whatever the server sent, so `status` may be missing or another value (e.g. "rejected").
 */
export interface ToolResult {
  status?: "ok" | "error" | (string & {});
  next?: string;
  error?: ToolErrorInfo;
  code?: string;
  error_code?: string;
  /** Set when a text block was not JSON. */
  text?: string;
  [key: string]: unknown;
}

/** Session turn as reported by the backend. */
export type Turn = "seller" | "buyer";

/** Requirement line, e.g. { category: "desk", max_width_in: 48 } or { category: "chair", ergonomic: true }. */
export type RequirementLine = {
  category?: string;
  quantity?: number;
  [attribute: string]: unknown;
};

export type Requirements = {
  region?: string;
  deliver_by?: string;
  items?: RequirementLine[];
  [key: string]: unknown;
};

export type OfferLineView = {
  inventory_id?: string;
  id?: string;
  quantity?: number;
  unit_cents?: number;
  title?: string;
};

export type OfferView = {
  offer_id?: string;
  id?: string;
  session_id?: string;
  items?: OfferLineView[];
  delivery_cents?: number;
  tax_cents?: number;
  total_cents?: number;
  note?: string;
  version?: number;
  created_at?: string;
};

export type CounterView = {
  counter_id?: string;
  id?: string;
  responding_to_offer_id?: string | null;
  total_cents?: number;
  note?: string;
  version?: number;
  created_at?: string;
};

/** A get_negotiation `history[]` entry: an offer (`type: "offer"`) or a counter (`type: "counter"`). */
export type HistoryEntry = OfferView & CounterView & { type?: string; kind?: string };

/**
 * Seller view of one session (get_negotiation). The backend's top-level `status` arrives renamed to
 * `session_status`. Alternative field names the mock brain tolerates are included.
 */
export type NegotiationView = {
  session_id?: string;
  id?: string;
  request_id?: string;
  seller_id?: string;
  seller_name?: string;
  status?: string;
  session_status?: string;
  turn?: Turn;
  version?: number;
  session_version?: number;
  rounds?: number;
  requirements?: Requirements;
  request?: { id?: string; request_id?: string; title?: string; requirements?: Requirements };
  delivery_cents?: number;
  seller?: { service_area?: string; delivery_cents?: number; delivery_days?: number };
  history?: HistoryEntry[];
  offers?: OfferView[];
  counters?: CounterView[];
  latest_counter?: CounterView | null;
  latest_offer?: OfferView | null;
  current_offer?: OfferView | null;
};

export type NegotiationResult = NegotiationView & {
  session?: NegotiationView;
  negotiation?: NegotiationView;
};

/** One get_inventory row. `floor_cents` is the seller's private minimum. */
export type InventoryItemView = {
  inventory_id?: string;
  id?: string;
  title?: string;
  sku?: string;
  category?: string;
  attributes?: Record<string, unknown>;
  list_cents?: number;
  price_cents?: number;
  floor_cents?: number;
  available?: number | boolean;
  quantity?: number;
};

/** get_inventory: the list arrives under `inventory` (adapter listKey); `items`/`data` are tolerated. */
export type InventoryResult = {
  inventory?: InventoryItemView[];
  items?: InventoryItemView[];
  data?: InventoryItemView[];
  delivery_cents?: number;
};

/** One seller session inside get_buy_order (nested sessions keep their own `status`). */
export type BuyOrderSessionView = {
  session_id?: string;
  id?: string;
  seller_id?: string;
  seller_name?: string;
  seller?: { name?: string };
  status?: string;
  session_status?: string;
  turn?: Turn;
  version?: number;
  rounds?: number;
  current_offer?: OfferView | null;
  latest_offer?: OfferView | null;
  latest_counter?: CounterView | null;
};

/** Buyer view of a buy order (get_buy_order); top-level `status` arrives renamed to `request_status`. */
export type BuyOrderView = {
  request_id?: string;
  id?: string;
  request_status?: string;
  title?: string;
  requirements?: Requirements;
  budget_cents?: number | null;
  target_cents?: number | null;
  sessions?: BuyOrderSessionView[];
};

export type BuyOrderResult = BuyOrderView & { request?: BuyOrderView; buy_order?: BuyOrderView };

export type MakeOfferResult = { offer_id?: string; version?: number; total_cents?: number; session_version?: number };
export type CounterOfferResult = { counter_id?: string; session_version?: number };
export type DeclineResult = { session_id?: string; session_status?: string; reason?: string };

/** Result data per tool, for the tools the runner's brains call. */
export interface ToolResults {
  get_negotiation: NegotiationResult;
  get_inventory: InventoryResult;
  make_offer: MakeOfferResult;
  decline_request: DeclineResult;
  get_buy_order: BuyOrderResult;
  counter_offer: CounterOfferResult;
  decline_seller: DeclineResult;
}

export type ToolResultFor<N extends string> = ToolResult & (N extends keyof ToolResults ? ToolResults[N] : unknown);

/** What a brain needs from an MCP connection. */
export type ToolCaller = Pick<McpToolClient, "call">;

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object";
}

/**
 * Normalize a tools/call result. The contract says tools return `{ status, ...data, next }` and report
 * errors as tool results. Prefer structuredContent, else parse the first JSON text block.
 */
export function parseToolResult(result: unknown): ToolResult {
  const r = isRecord(result) ? result : undefined;
  let out: Record<string, unknown> | null = null;
  if (r?.structuredContent && typeof r.structuredContent === "object") out = { ...r.structuredContent };
  if (!out) {
    // The SDK validates `content` as an array of content blocks.
    const content: unknown[] = Array.isArray(r?.content) ? r.content : [];
    const block = content.find((c) => isRecord(c) && c.type === "text");
    const text = isRecord(block) ? block.text : undefined;
    if (typeof text === "string" && text) {
      try {
        const parsed: unknown = JSON.parse(text);
        out = isRecord(parsed) ? parsed : { text };
      } catch {
        out = { text };
      }
    } else {
      out = {};
    }
  }
  if (out && typeof out === "object" && "data" in out && out.data && typeof out.data === "object" && !Array.isArray(out.data) && !out.status) {
    out = { ...out.data, status: "ok" }; // tolerate a raw backend envelope
  }
  if (r?.isError && !out.status) out.status = "error";
  if (out.error && !out.status) out.status = "error";
  // Fields are as the server sent them; ToolResult documents the contract shape.
  return out as ToolResult;
}

export function isToolError(r: ToolResult | null | undefined): boolean {
  return r?.status === "error" || r?.status === "rejected" || Boolean(r?.error);
}

export function toolErrorCode(r: ToolResult | null | undefined): string | null {
  return r?.code || r?.error?.code || r?.error_code || null;
}

export class McpToolClient {
  url: string;
  token: string;
  agentId: string;
  client: Client | null;

  constructor({ url, token, agentId }: { url: string; token: string; agentId: string }) {
    this.url = url;
    this.token = token;
    this.agentId = agentId;
    this.client = null;
  }

  async connect(): Promise<this> {
    const client = new Client({ name: `exchangent-agent-${this.agentId}`, version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    await client.connect(transport);
    this.client = client;
    return this;
  }

  async call<N extends string>(name: N, args: Record<string, unknown> = {}): Promise<ToolResultFor<N>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.client) await this.connect();
        const res = await this.client!.callTool({ name, arguments: args }); // connect() sets client
        const parsed = parseToolResult(res);
        log.info(`${name}`, { agent: this.agentId, status: parsed.status, code: toolErrorCode(parsed) || undefined });
        // Result data follows mcp/src/tools.ts for this tool; it is not validated field by field.
        return parsed as ToolResultFor<N>;
      } catch (err) {
        // Session expired or server restarted: reconnect once.
        await this.close();
        if (attempt === 1) throw err;
      }
    }
    throw new Error("unreachable"); // the second failed attempt rethrows above
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => {});
  }
}
