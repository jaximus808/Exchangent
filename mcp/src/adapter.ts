/**
 * Thin HTTP adapter between MCP tool calls and the Exchangent backend.
 *
 * - Bearer mode (default): forwards the MCP caller's `Authorization: Bearer ...`
 *   header (falls back to `EXCHANGENT_TOKEN` only when the MCP request carried no header).
 * - OAuth mode (`EXCHANGENT_AUTH=oauth`): forwards the signed-in user's Exchangent
 *   connector token (`exc_…`) held by the mcp-use OAuth proxy (`upstreamToken(ctx.auth)`).
 *   The MCP request's own `Authorization` header (the proxy's `mcp_at_…` token)
 *   and `EXCHANGENT_TOKEN` are never used.
 * - Sends a deterministic `Idempotency-Key` on every mutation.
 * - Maps the backend envelope (`{ data }` / `{ error: { code, message, next_action } }`)
 *   into `{ status: "ok" | "error", ...data, next }` tool results. Errors are
 *   returned as tool results, never thrown.
 *
 * No business rules live here: the backend is the source of truth for prices,
 * budgets, floors, turns and versions. This module only formats what the
 * backend returned.
 */
import { createHash } from "node:crypto";
import type { CallToolResult } from "mcp-use";
import { upstreamToken } from "mcp-use/oauth";
import { authMode } from "./auth.ts";

export const DEFAULT_API_URL = "http://127.0.0.1:8787/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

/** Backend base URL, read per call so tests and redeploys can change it. */
export function apiBaseUrl(): string {
  return (process.env.EXCHANGENT_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** Minimal view of the mcp-use request context that the adapter needs. */
export interface CallContext {
  signal?: AbortSignal;
  request?: { header(name: string): string | undefined };
  /** Verified OAuth identity (oauth mode only); `upstream` holds the Exchangent connector token (`exc_…`). */
  auth?: { upstream?: { accessToken: string; scopes: string[]; expiresAt?: number }; user?: unknown };
}

/**
 * Resolve the bearer credential for this tool call.
 *
 * OAuth mode: the Exchangent connector token the proxy stored for the signed-in
 * user. Nothing else is ever forwarded.
 *
 * Bearer mode:
 * 1. The incoming MCP HTTP request's `Authorization: Bearer <token>` header.
 * 2. `EXCHANGENT_TOKEN` env, only when the MCP request had no Authorization header.
 */
export function resolveAuthorization(ctx: CallContext): string | undefined {
  if (authMode() === "oauth") {
    if (!ctx.auth?.upstream) return undefined;
    try {
      return `Bearer ${upstreamToken(ctx.auth)}`;
    } catch {
      return undefined;
    }
  }
  const incoming = ctx.request?.header("authorization")?.trim();
  if (incoming) return /^bearer\s+\S+/i.test(incoming) ? incoming : undefined;
  const fallback = process.env.EXCHANGENT_TOKEN?.trim();
  return fallback ? `Bearer ${fallback}` : undefined;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic idempotency key: tool name + target id + expected_version +
 * a hash of the request body. A model retrying the exact same call reuses the
 * key, so the backend replays the first result instead of double-submitting.
 */
export function deriveIdempotencyKey(
  tool: string,
  targetId: string | undefined,
  expectedVersion: number | undefined,
  body: unknown,
): string {
  const bodyHash = createHash("sha256").update(canonicalJson(body ?? {})).digest("hex").slice(0, 24);
  const parts = ["mcp", tool, targetId ?? "new"];
  if (expectedVersion !== undefined) parts.push(`v${expectedVersion}`);
  parts.push(bodyHash);
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// Money formatting (formatting only, never computation)
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/**
 * Recursively add a `<name>_display` string (e.g. "$1,234.50") next to every
 * integer `<name>_cents` field the backend returned. Never invents numbers.
 */
export function withDisplayMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withDisplayMoney);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = withDisplayMoney(v);
    if (key.endsWith("_cents") && Number.isInteger(v)) {
      const displayKey = `${key.slice(0, -"_cents".length)}_display`;
      if (!(displayKey in (value as Record<string, unknown>))) out[displayKey] = formatCents(v as number);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error hints
// ---------------------------------------------------------------------------

/** Per-tool hints used to tailor `next` sentences. */
export interface HintContext {
  /** The tool that re-reads current state for this caller (e.g. get_negotiation). */
  reread: string;
  /** "buyer" or "seller": which side calls this tool. */
  role: "buyer" | "seller";
}

export function errorNext(code: string, nextAction: string | undefined, hint: HintContext): string {
  switch (code) {
    case "stale_offer":
      return `The negotiation changed since you last read it; call ${hint.reread} to get the current version and turn, then decide again using that expected_version.`;
    case "not_your_turn":
      return `It is the other party's turn; do not retry now — wait for their response, then call ${hint.reread} to re-read the session.`;
    case "below_floor":
      return "At least one unit price is below your floor for that item; call get_inventory to check your floors and make a new offer at or above them, or decline_request.";
    case "budget_exceeded":
      return "That amount is above the buyer's private budget; counter at a lower total_cents, or stop and ask the human before going higher.";
    case "out_of_stock":
      return hint.role === "seller"
        ? "Not enough stock for that item; call get_inventory and offer items and quantities that are available, or decline_request."
        : "The offered items are no longer in stock; call list_offers and choose a different offer.";
    case "session_closed":
      return "This negotiation session is closed or declined; stop acting on it and use your other open sessions instead.";
    case "unauthorized":
      if (authMode() === "oauth") {
        return "Exchangent rejected this connection's sign-in (it expired or was revoked); stop and ask the human to reconnect the Exchangent connector and sign in again (Claude Code: run /mcp, select exchangent, choose re-authenticate), then retry.";
      }
      return "No valid bearer token reached the backend; ask the human to reconnect this MCP server with an `Authorization: Bearer <token>` header (or set EXCHANGENT_TOKEN for local dev).";
    case "forbidden":
      if (authMode() === "oauth") {
        return "This connection is authorized for a different account or role than this action needs; call whoami to see which buyer account or business it acts for. To switch, the human must reconnect the Exchangent connector and pick the other account on the consent screen.";
      }
      return "Your token is not allowed to act on this resource; use only your own requests or sessions and the tools for your role (buyer or seller).";
    case "offer_expired":
      return "That offer has expired; call list_offers to see current offers, or counter_offer on the session to ask for a fresh one.";
    case "reservation_expired":
      return "The reservation hold expired; call reserve_offer again on a current offer with a new idempotency_key.";
    case "idempotency_conflict":
      return "That idempotency key was already used for a different request; if you really intend a new action, retry with a new idempotency_key.";
    case "payment_pending":
      return "Payment is still processing; call get_reservation_status again in a little while.";
    case "price_changed":
      return "The saved total differs from the approved amount. Re-read the offers and ask the human to approve the current total before retrying.";
    case "invalid_input":
      return "The backend rejected the inputs; fix them according to the error message and retry once.";
    case "not_found":
      return `That ID was not found or is not visible to you; re-check the ID with ${hint.reread}.`;
    case "backend_unreachable":
      return "The Exchangent backend could not be reached; retry the same call shortly (it is safe — the idempotency key is unchanged).";
    default:
      return nextAction
        ? `The backend suggests: ${nextAction.replace(/\.+$/, "")}. Re-read current state with ${hint.reread} before trying again.`
        : `The call failed; re-read current state with ${hint.reread} before trying again.`;
  }
}

// ---------------------------------------------------------------------------
// Backend call + result mapping
// ---------------------------------------------------------------------------

export interface BackendCall {
  method: "GET" | "POST";
  /** Path below the API base, e.g. `/sessions/<id>/offers`. */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Required for POST: explicit key from the model, or derived. */
  idempotencyKey?: string;
}

export type BackendResult =
  | { ok: true; httpStatus: number; data: unknown }
  | { ok: false; httpStatus: number; code: string; message: string; nextAction?: string };

export async function callBackend(ctx: CallContext, call: BackendCall): Promise<BackendResult> {
  const authorization = resolveAuthorization(ctx);
  if (!authorization) {
    const message = authMode() === "oauth"
      ? "This MCP connection has no Exchangent sign-in."
      : "No bearer token: the MCP request had no Authorization header and EXCHANGENT_TOKEN is not set.";
    return { ok: false, httpStatus: 401, code: "unauthorized", message };
  }
  const url = new URL(apiBaseUrl() + call.path);
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  const headers: Record<string, string> = { Accept: "application/json", Authorization: authorization };
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  if (call.idempotencyKey) headers["Idempotency-Key"] = call.idempotencyKey;

  const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)];
  if (ctx.signal) signals.push(ctx.signal);

  let response: Response;
  try {
    response = await fetch(url, {
      method: call.method,
      headers,
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    return { ok: false, httpStatus: 0, code: "backend_unreachable", message: `Request to the Exchangent backend failed: ${(err as Error).message}` };
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (payload && typeof payload === "object" && payload.error && typeof payload.error === "object") {
    return {
      ok: false,
      httpStatus: response.status,
      code: String(payload.error.code ?? "backend_error"),
      message: String(payload.error.message ?? "The backend returned an error."),
      nextAction: payload.error.next_action ? String(payload.error.next_action) : undefined,
    };
  }
  if (!response.ok || !payload || typeof payload !== "object" || !("data" in payload)) {
    return { ok: false, httpStatus: response.status, code: response.status === 404 ? "not_found" : "backend_error", message: `Unexpected backend response (HTTP ${response.status}).` };
  }
  return { ok: true, httpStatus: response.status, data: payload.data };
}

export interface ShapeOptions {
  /** Wrap an array response under this key, e.g. `offers`. */
  listKey?: string;
  /**
   * The envelope reserves `status` for "ok"/"error"; a backend `status` field is
   * renamed to this key (e.g. `session_status`).
   */
  statusKey?: string;
  /** Rename other top-level backend keys to avoid confusing the model. */
  rename?: Record<string, string>;
}

/** Flatten backend data into a plain object that can be spread into the result. */
export function shapeData(data: unknown, opts: ShapeOptions = {}): Record<string, unknown> {
  let obj: Record<string, unknown>;
  if (Array.isArray(data)) obj = { [opts.listKey ?? "items"]: data };
  else if (data && typeof data === "object") obj = { ...(data as Record<string, unknown>) };
  else obj = { result: data ?? null };
  if ("status" in obj) {
    obj[opts.statusKey ?? "resource_status"] = obj.status;
    delete obj.status;
  }
  for (const [from, to] of Object.entries(opts.rename ?? {})) {
    if (from in obj && !(to in obj)) {
      obj[to] = obj[from];
      delete obj[from];
    }
  }
  return withDisplayMoney(obj) as Record<string, unknown>;
}

/** Envelope carried in `structuredContent` of every Exchangent tool result. */
export type Envelope = { [key: string]: unknown; status: "ok" | "error"; next: string };
export type ExchangentResult = CallToolResult & { structuredContent: Envelope };

function toResult(structured: Envelope, isError: boolean): ExchangentResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

export function okResult(data: Record<string, unknown>, next: string): ExchangentResult {
  return toResult({ status: "ok", ...data, next }, false);
}

export function errorResult(
  err: Extract<BackendResult, { ok: false }>,
  hint: HintContext,
): ExchangentResult {
  return toResult(
    {
      status: "error",
      error: { code: err.code, message: err.message, next_action: err.nextAction ?? null, http_status: err.httpStatus },
      next: errorNext(err.code, err.nextAction, hint),
    },
    true,
  );
}

/**
 * Run one tool: call the backend, then shape either the data or the error.
 * `next` receives the shaped data so it can reference returned IDs/versions.
 */
export async function runTool(
  ctx: CallContext,
  call: BackendCall,
  hint: HintContext,
  shape: ShapeOptions,
  next: (data: Record<string, unknown>) => string,
): Promise<ExchangentResult> {
  const result = await callBackend(ctx, call);
  if (!result.ok) return errorResult(result, hint);
  const data = shapeData(result.data, shape);
  return okResult(data, next(data));
}
