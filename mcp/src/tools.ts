/**
 * Exchangent MCP tools. Each tool is a thin wrapper over one backend endpoint
 * from doc/negotiation-contract.md. The backend resolves the bearer token to a
 * buyer or seller principal and enforces every rule (scope, turn, version,
 * budget, floor, stock); these tools only translate inputs and outputs.
 */
import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { callBackend, deriveIdempotencyKey, errorResult, okResult, runTool, shapeData, type CallContext, type HintContext } from "./adapter.ts";
import { authMode, type ExchangentUser } from "./auth.ts";

const id = (what: string) => z.string().min(1).describe(`The ${what} ID (UUID) returned by an earlier Exchangent tool.`);
const cents = (what: string) =>
  z.number().int().positive().describe(`${what}, in integer US cents (e.g. 12500 = $125.00). Never send dollars.`);
const expectedVersion = z
  .number()
  .int()
  .min(0)
  .describe("The session `version` you last read (from get_negotiation / get_buy_order). The call fails with stale_offer if the session has moved on.");
const idempotencyKey = z
  .string()
  .min(8)
  .max(200)
  .optional()
  .describe("Optional. Leave empty: a deterministic key is derived so retrying the identical call can never double-submit. Only set a new value to deliberately repeat an action.");

/** Advertised result shape: always `status` and `next`, plus the backend's data. */
const resultSchema = z.looseObject({
  status: z.enum(["ok", "error"]).describe("ok on success; error when the backend rejected the call (see `error` and `next`)."),
  next: z.string().describe("One sentence telling you what to do next."),
});

const BUYER: HintContext = { role: "buyer", reread: "get_buy_order" };
const SELLER: HintContext = { role: "seller", reread: "get_negotiation" };
const WHOAMI: HintContext = { role: "buyer", reread: "whoami" };

const BUYER_NEXT = "This connection acts for a buyer: use create_buy_order, get_buy_order, list_offers, counter_offer, decline_seller, reserve_offer, get_checkout_link and get_reservation_status.";
const sellerNext = (sellerId: unknown) =>
  `This connection acts for business ${String(sellerId)}: use list_my_requests, get_negotiation, get_inventory, make_offer and decline_request.`;

const seg = (value: string) => encodeURIComponent(value);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerTools(server: MCPServer) {
  // -------------------------------------------------------------------------
  // Buyer tools
  // -------------------------------------------------------------------------

  const create_buy_order=server.tool(
    {
      name: "create_buy_order",
      title: "Create buy order",
      description:
        "Buyer: post what you want to buy (e.g. a desk and a chair delivered in San Francisco). The backend matches sellers and opens one negotiation session per seller; notification events are queued for the agent dispatcher. This opens an interactive buyer panel. This does NOT purchase or charge anything. budget_cents is the buyer's private all-in ceiling and is never shown to sellers.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Short human-readable title, e.g. \"Standing desk + ergonomic chair\"."),
        requirements: z
          .looseObject({
            region: z.string().optional().describe("Service region, e.g. \"san_francisco\"."),
            deliver_by: z.string().optional().describe("Latest delivery date, YYYY-MM-DD."),
            items: z
              .array(
                z
                  .looseObject({
                    category: z.string().describe("Item category, e.g. \"desk\" or \"chair\"."),
                    max_width_in: z.number().optional().describe("Maximum width in inches (desks)."),
                    ergonomic: z.boolean().optional().describe("Require an ergonomic model (chairs)."),
                  })
                  .describe("One wanted item; extra attribute constraints are passed through to the backend."),
              )
              .min(1)
              .describe("The items wanted, one entry per item."),
          })
          .describe("Structured requirements sent to the backend as-is."),
        budget_cents: cents("Private maximum all-in total the buyer will pay (items + delivery)"),
        target_cents: cents("Optional private target total the buyer hopes to pay").optional(),
        deadline: z.string().optional().describe("Optional ISO 8601 timestamp after which the request expires."),
        delegate_negotiation: z.boolean().optional().describe("Let the buyer agent negotiate automatically (backend default: true)."),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      view: { name: "buyer-order", description: "Exchangent buyer order panel", prefersBorder: true },
      annotations: mutation,
    },
    async (input, ctx) => {
      const { idempotency_key, ...body } = input;
      return runTool(
        ctx as CallContext,
        { method: "POST", path: "/buy-requests", body, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("create_buy_order", undefined, undefined, body) },
        BUYER,
        { statusKey: "request_status" },
        (d) => `Buy order ${d.request_id ?? ""} is open with ${Array.isArray(d.sessions) ? d.sessions.length : 0} seller session(s); call list_offers or get_buy_order later to see seller offers.`,
      );
    },
  );

  const get_buy_order=server.tool(
    {
      name: "get_buy_order",
      title: "Get buy order",
      description:
        "Buyer: open an interactive request and offer-comparison panel for one of your buy orders — its status and requirements, your own private budget/target, and every seller session (status, turn, version, rounds, current seller offer and your latest counter). Use the session `version` as expected_version for counter_offer.",
      inputSchema: z.object({ request_id: id("buy order (request)") }),
      outputSchema: resultSchema,
      view: { name: "buyer-status", description: "Exchangent buyer order panel", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ request_id }, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: `/buy-requests/${seg(request_id)}` }, BUYER, { statusKey: "request_status" }, () =>
        "For sessions where turn is \"buyer\", either reserve_offer on an acceptable current offer, counter_offer with that session's version, or decline_seller; otherwise wait for sellers.",
      ),
  );

  const list_offers=server.tool(
    {
      name: "list_offers",
      title: "List offers",
      description:
        "Buyer: display an interactive comparison of current seller offers for one of your buy orders, sorted by all-in total (cheapest first). Each offer includes its offer_id, session_id, line items and totals.",
      inputSchema: z.object({ request_id: id("buy order (request)") }),
      outputSchema: resultSchema,
      view: { name: "buyer-offers", description: "Exchangent buyer offers panel", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ request_id }, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: `/buy-requests/${seg(request_id)}/offers` }, BUYER, { listKey: "offers" }, (d) =>
        Array.isArray(d.offers) && d.offers.length === 0
          ? "No seller offers yet; wait and call list_offers again later."
          : "To accept an offer call reserve_offer with its offer_id; to negotiate call counter_offer on its session_id (get the session version from get_buy_order).",
      ),
  );

  const counter_offer=server.tool(
    {
      name: "counter_offer",
      title: "Counter a seller offer",
      description:
        "Buyer: propose a lower all-in total to one seller in a negotiation session. Only allowed when it is the buyer's turn, and total_cents must not exceed the buyer's private budget (the backend enforces both). The seller accepts by making a new offer at that price.",
      inputSchema: z.object({
        session_id: id("negotiation session"),
        expected_version: expectedVersion,
        total_cents: cents("Proposed all-in total (items + delivery)"),
        note: z.string().max(1000).optional().describe("Short message to the seller explaining the counter."),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ session_id, expected_version, total_cents, note, idempotency_key }, ctx) => {
      const body = { expected_version, total_cents, note: note ?? "" };
      return runTool(
        ctx as CallContext,
        { method: "POST", path: `/sessions/${seg(session_id)}/counters`, body, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("counter_offer", session_id, expected_version, body) },
        BUYER,
        {},
        () => "Counter sent; it is now the seller's turn — wait for their response, then call list_offers or get_buy_order.",
      );
    },
  );

  const decline_seller=server.tool(
    {
      name: "decline_seller",
      title: "Decline a seller",
      description: "Buyer: end the negotiation with one seller (closes that session). Other sessions for the same buy order are unaffected.",
      inputSchema: z.object({
        session_id: id("negotiation session"),
        reason: z.string().max(1000).optional().describe("Short reason shared with the seller."),
        expected_version: expectedVersion.optional(),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    async ({ session_id, reason, expected_version, idempotency_key }, ctx) => {
      const body = { reason: reason ?? "", ...(expected_version !== undefined ? { expected_version } : {}) };
      return runTool(
        ctx as CallContext,
        { method: "POST", path: `/sessions/${seg(session_id)}/decline`, body, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("decline_seller", session_id, expected_version, body) },
        BUYER,
        { statusKey: "session_status" },
        () => "That seller session is declined; continue with your remaining sessions via get_buy_order.",
      );
    },
  );

  const reserve_offer=server.tool(
    {
      name: "reserve_offer",
      title: "Reserve an offer",
      description:
        "Buyer: accept a seller's current offer by reserving it. This atomically holds the items for a limited time but does NOT charge — the human pays later in Stripe Checkout (see get_checkout_link). Only seller-authored offers can be reserved, and only one active reservation per buy order.",
      inputSchema: z.object({
        offer_id: id("seller offer"),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ offer_id, idempotency_key }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/offers/${seg(offer_id)}/reservations`, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("reserve_offer", offer_id, undefined, {}) },
        BUYER,
        { statusKey: "reservation_status", rename: { id: "reservation_id" } },
        (d) => `Items are held; call get_checkout_link with reservation_id ${d.reservation_id ?? ""} and give the link to the human to pay.`,
      ),
  );

  const get_checkout_link=server.tool(
    {
      name: "get_checkout_link",
      title: "Get checkout link",
      description:
        "Buyer: open a checkout-approval panel and create (or return the existing) Stripe test Checkout link for a reservation. The price comes from the saved offer; you cannot change it. Only the human can approve payment, by opening the link.",
      inputSchema: z.object({
        reservation_id: id("reservation"),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      view: { name: "checkout", description: "Exchangent checkout panel", prefersBorder: true },
      annotations: mutation,
    },
    async ({ reservation_id, idempotency_key }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/reservations/${seg(reservation_id)}/checkout`, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("get_checkout_link", reservation_id, undefined, {}) },
        BUYER,
        // Stripe's `session_id` is not a negotiation session; rename to avoid mix-ups.
        { statusKey: "reservation_status", rename: { session_id: "checkout_session_id", url: "checkout_url" } },
        () => "Give checkout_url to the human to pay (Stripe test mode); then call get_reservation_status to confirm payment — never assume it is paid.",
      ),
  );

  const get_reservation_status=server.tool(
    {
      name: "get_reservation_status",
      title: "Get reservation status",
      description:
        "Buyer: open an interactive reservation and order-status panel. Payment is confirmed only by the backend's verified Stripe webhook, so use this (not the checkout redirect) to know whether the order is paid.",
      inputSchema: z.object({ reservation_id: id("reservation") }),
      outputSchema: resultSchema,
      view: { name: "order-status", description: "Exchangent checkout panel", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ reservation_id }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "GET", path: `/reservations/${seg(reservation_id)}` },
        BUYER,
        { statusKey: "reservation_status" },
        (d) => {
          switch (d.reservation_status) {
            case "consumed":
              return "Payment is confirmed and the order is placed; tell the human it is done (delivery is separate from payment).";
            case "payment_pending":
              return "Payment is processing; check get_reservation_status again later.";
            case "held":
            case "checkout_open":
              return "Waiting for the human to pay; share the checkout link (get_checkout_link) if they need it, then check again later.";
            case "expired":
            case "cancelled":
              return "This reservation is no longer active; call list_offers and reserve_offer again if the human still wants to buy.";
            default:
              return "Report this status to the human and check again later if it is not final.";
          }
        },
      ),
  );

  // -------------------------------------------------------------------------
  // Seller tools
  // -------------------------------------------------------------------------

  const list_my_requests=server.tool(
    {
      name: "list_my_requests",
      title: "List my buyer requests",
      description:
        "Seller: open an interactive business panel listing your negotiation sessions (one per matched buyer request) with the request title, requirements, whose turn it is, the session version and rounds so far.",
      inputSchema: z.object({
        status: z.enum(["open", "declined", "closed"]).optional().describe("Filter by session status (default: open)."),
      }),
      outputSchema: resultSchema,
      view: { name: "seller-desk", description: "Exchangent seller desk panel", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ status }, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: "/seller/sessions", query: { status: status ?? "open" } }, SELLER, { listKey: "sessions" }, () =>
        "For each session where turn is \"seller\", call get_negotiation for its full history, then make_offer or decline_request.",
      ),
  );

  const get_negotiation=server.tool(
    {
      name: "get_negotiation",
      title: "Get negotiation",
      description:
        "Read one negotiation session as your role sees it: buyer requirements, the full history of seller offers and buyer counters with notes, whose turn it is and the current version. Always call this before make_offer and use its version as expected_version.",
      inputSchema: z.object({ session_id: id("negotiation session") }),
      outputSchema: resultSchema,
      view: { name: "negotiation", description: "Exchangent seller desk panel", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ session_id }, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: `/sessions/${seg(session_id)}` }, SELLER, { statusKey: "session_status" }, (d) => {
        if (d.session_status && d.session_status !== "open") return "This session is no longer open; take no further action on it.";
        const version = d.version !== undefined ? ` with expected_version ${String(d.version)}` : "";
        if (d.turn === "seller") return `It is the seller's turn: call make_offer${version} (check get_inventory for prices and floors) or decline_request.`;
        if (d.turn === "buyer") return "It is the buyer's turn; wait for their response.";
        return `Act only if it is your turn, using expected_version from this session${version ? ` (${String(d.version)})` : ""}.`;
      }),
  );

  const get_inventory=server.tool(
    {
      name: "get_inventory",
      title: "Get my inventory",
      description:
        "Seller: list your own inventory — inventory_id, title, category, attributes, list_cents (list price), floor_cents (your private minimum, never shown to buyers) and available quantity.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      view: { name: "inventory", description: "Exchangent seller desk panel", prefersBorder: true },
      annotations: readOnly,
    },
    async (_input, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: "/seller/inventory" }, SELLER, { listKey: "inventory" }, () =>
        "Use these inventory_id values and prices (never below floor_cents) when calling make_offer.",
      ),
  );

  const make_offer=server.tool(
    {
      name: "make_offer",
      title: "Make an offer",
      description:
        "Seller: send an offer in a negotiation session — the line items you will sell with a unit price each, plus delivery. The backend computes the total and rejects prices below your floor, unavailable stock, stale versions and out-of-turn calls. To accept a buyer's counter, make a new offer at the countered total.",
      inputSchema: z.object({
        session_id: id("negotiation session"),
        expected_version: expectedVersion,
        items: z
          .array(
            z.object({
              inventory_id: z.string().min(1).describe("inventory_id from get_inventory."),
              quantity: z.number().int().positive().describe("Number of units."),
              unit_cents: cents("Price per unit"),
            }),
          )
          .min(1)
          .describe("Line items in this offer."),
        delivery_cents: z.number().int().min(0).describe("Delivery fee in integer US cents (0 for free delivery)."),
        note: z.string().max(1000).optional().describe("Short message to the buyer."),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ session_id, expected_version, items, delivery_cents, note, idempotency_key }, ctx) => {
      const body = { expected_version, items, delivery_cents, note: note ?? "" };
      return runTool(
        ctx as CallContext,
        { method: "POST", path: `/sessions/${seg(session_id)}/offers`, body, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("make_offer", session_id, expected_version, body) },
        SELLER,
        {},
        () => "Offer sent; it is now the buyer's turn — wait for their response before acting on this session again.",
      );
    },
  );

  const decline_request=server.tool(
    {
      name: "decline_request",
      title: "Decline a buyer request",
      description: "Seller: decline a buyer's request and close this negotiation session (e.g. you cannot meet the requirements or the counter is below your floor).",
      inputSchema: z.object({
        session_id: id("negotiation session"),
        reason: z.string().max(1000).optional().describe("Short reason shared with the buyer."),
        expected_version: expectedVersion.optional(),
        idempotency_key: idempotencyKey,
      }),
      outputSchema: resultSchema,
      annotations: { ...mutation, destructiveHint: true },
    },
    async ({ session_id, reason, expected_version, idempotency_key }, ctx) => {
      const body = { reason: reason ?? "", ...(expected_version !== undefined ? { expected_version } : {}) };
      return runTool(
        ctx as CallContext,
        { method: "POST", path: `/sessions/${seg(session_id)}/decline`, body, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("decline_request", session_id, expected_version, body) },
        SELLER,
        { statusKey: "session_status" },
        () => "The session is declined; take no further action on it.",
      );
    },
  );
  // -------------------------------------------------------------------------
  // Identity (both auth modes)
  // -------------------------------------------------------------------------

  const whoami=server.tool(
    {
      name: "whoami",
      title: "Who am I",
      description:
        "Show which Exchangent account this MCP connection acts for: the auth mode (bearer or oauth) and the signed-in actor, principal kind, granted scope (buyer or seller) and, for a business, its seller_id. Call it first if you are unsure whether to use buyer or seller tools. Never returns tokens.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    async (_input, ctx) => {
      const call = ctx as CallContext;
      if (authMode() === "oauth") {
        const user = call.auth?.user as ExchangentUser | undefined;
        if (!user) {
          return errorResult({ ok: false, httpStatus: 401, code: "unauthorized", message: "This MCP connection has no Exchangent sign-in." }, WHOAMI);
        }
        const expiresAt = call.auth?.upstream?.expiresAt;
        return okResult(
          {
            auth_mode: "oauth",
            signed_in: true,
            actor_id: user.actor_id,
            kind: user.kind,
            acting_as: user.acting_as,
            seller_id: user.seller_id,
            scope: user.scope,
            client_id: user.client_id,
            ...(expiresAt ? { authorization_expires_at: new Date(expiresAt * 1000).toISOString() } : {}),
          },
          user.seller_id ? sellerNext(user.seller_id) : BUYER_NEXT,
        );
      }
      const result = await callBackend(call, { method: "GET", path: "/me" });
      if (!result.ok) {
        const err = errorResult(result, WHOAMI);
        err.structuredContent.auth_mode = "bearer";
        err.content = [{ type: "text", text: JSON.stringify(err.structuredContent, null, 2) }];
        return err;
      }
      const data = shapeData(result.data);
      return okResult({ auth_mode: "bearer", ...data }, data.seller_id ? sellerNext(data.seller_id) : BUYER_NEXT);
    },
  );

  return {whoami, create_buy_order, get_buy_order, list_offers, counter_offer, decline_seller, reserve_offer, get_checkout_link, get_reservation_status, list_my_requests, get_negotiation, get_inventory, make_offer, decline_request};
}
