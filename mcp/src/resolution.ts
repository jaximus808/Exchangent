/**
 * Order fulfilment and dispute-resolution tools (doc/resolution-contract.md). Like the
 * negotiation tools, each one is a thin wrapper over one backend endpoint: the backend
 * computes and caps every refund, checks turns and versions, and applies each side's
 * resolution policy. A backend that predates these routes answers 404, which the hints
 * turn into "not enabled yet" instead of a confusing ID error.
 */
import type { MCPServer } from "mcp-use";
import { z } from "zod";
import { deriveIdempotencyKey, runTool, type CallContext, type HintContext } from "./adapter.ts";

const id = (what: string) => z.string().min(1).describe(`The ${what} ID returned by an earlier Exchangent tool.`);
const seg = (value: string) => encodeURIComponent(value);
const resultSchema = z.looseObject({
  status: z.enum(["ok", "error"]).describe("ok on success; error when the backend rejected the call (see `error` and `next`)."),
  next: z.string().describe("One sentence telling you what to do next."),
});
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const FEATURE = "Order tracking and dispute resolution";
const BUYER_ORDER: HintContext = { role: "buyer", reread: "list_my_orders", feature: { name: FEATURE } };
const BUYER_ORDERS: HintContext = { ...BUYER_ORDER, feature: { name: FEATURE, list: true } };
const SELLER_ORDER: HintContext = { role: "seller", reread: "list_orders", feature: { name: FEATURE } };
const SELLER_ORDERS: HintContext = { ...SELLER_ORDER, feature: { name: FEATURE, list: true } };
const CASE: HintContext = { role: "buyer", reread: "get_case", feature: { name: FEATURE } };
const SELLER_CASE: HintContext = { role: "seller", reread: "get_case", feature: { name: FEATURE } };
const POLICY: HintContext = { role: "seller", reread: "get_resolution_policy", feature: { name: "Resolution policies", list: true } };

const CASE_TYPES = ["not_received", "not_as_described", "damaged", "missing_item", "late", "wrong_item", "changed_mind", "duplicate_charge"] as const;
const REMEDY_KINDS = ["refund_full", "refund_partial", "refund_items", "replace", "return_for_refund", "keep_with_discount", "sla_credit", "cancel"] as const;

const REMEDY_DOC =
  "A remedy is one of: refund_full (everything back), refund_partial (amount_cents back, the buyer keeps the goods), refund_items (refund the listed items at the price paid), replace (the seller ships a replacement, no money moves), return_for_refund (the buyer sends it back and is refunded when the seller confirms the return; set return_shipping_paid_by), keep_with_discount (keep it with amount_cents back; usually cheapest for bulky items like furniture), sla_credit (the delivery fee back for a late delivery) or cancel (before it ships only). The backend computes and caps every amount at what is still refundable on the order, so you can never over-refund.";

const itemRef = z
  .looseObject({ quantity: z.number().int().positive().optional().describe("Units affected (default: all of that item).") })
  .describe("One order item: copy it from get_order's items, keeping its id field exactly as returned, and add quantity.");

const remedy = z
  .object({
    kind: z.enum(REMEDY_KINDS).describe("What should happen."),
    amount_cents: z.number().int().positive().optional().describe("For refund_partial and keep_with_discount: the amount back, in integer US cents."),
    items: z.array(itemRef).optional().describe("For refund_items and replace: the affected items."),
    substitute: z
      .object({ inventory_id: z.string().min(1), quantity: z.number().int().positive(), replaces: z.string().min(1).optional().describe("inventory_id of the order item it replaces.") })
      .optional()
      .describe("For replace with a different item: the seller's substitute inventory item."),
    return_shipping_paid_by: z.enum(["buyer", "seller"]).optional().describe("For return_for_refund: who pays return shipping."),
  })
  .describe(REMEDY_DOC);

const evidence = z.object({
  kind: z.enum(["photo", "measurement", "text", "tracking"]).describe("photo: an image URL; measurement: e.g. \"width 50in\"; text: a statement; tracking: a carrier tracking reference."),
  ref: z.string().min(1).max(2000).describe("The URL, measurement, text or tracking reference."),
});

const caseNext = (d: Record<string, unknown>) => {
  const resolution = d.resolution as { kind?: unknown; how?: unknown } | null | undefined;
  if (d.case_status === "resolved" && resolution) {
    return `Resolved (${String(resolution.how ?? "agreed")}): ${String(resolution.kind ?? "remedy")}. Any refund is issued to the original payment; call get_case to show the human the outcome.`;
  }
  if (d.case_status === "escalated") return "This case went past what both sides' policies allow automatically and needs a person; tell the human it was escalated.";
  if (d.case_status === "closed") return "This case is closed; no further action.";
  return `The case is open and it is the ${String(d.turn ?? "other party")}'s turn. Respond with respond_to_case (pass version as expected_version) when it is yours, or call get_case later.`;
};

export function registerResolutionTools(server: MCPServer) {
  // ---------------------------------------------------------------------------
  // Buyer
  // ---------------------------------------------------------------------------

  const list_my_orders = server.tool(
    {
      name: "list_my_orders",
      title: "List my orders",
      description: "Buyer: list your paid orders with their fulfilment status (confirmed, shipped, delivered, closed, cancelled, refunded), amounts refunded and any open problem cases.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    async (_input, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: "/orders" }, BUYER_ORDERS, { listKey: "orders" }, (d) =>
        Array.isArray(d.orders) && d.orders.length === 0
          ? "No paid orders yet; orders appear here after a checkout is paid."
          : "Call get_order with an order_id for shipping, cases and refunds. If something went wrong with an order, call open_case.",
      ),
  );

  const get_order = server.tool(
    {
      name: "get_order",
      title: "Get order",
      description: "Buyer: open one order's panel — what you bought, its shipping timeline (shipped, delivered, and whether the delivery scan was real or simulated for testing), problem cases with every move, and refunds.",
      inputSchema: z.object({ order_id: id("order") }),
      outputSchema: resultSchema,
      view: { name: "order-detail", description: "Exchangent order and problem cases", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ order_id }, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: `/orders/${seg(order_id)}` }, BUYER_ORDER, { statusKey: "order_status" }, (d) =>
        d.order_status === "shipped"
          ? "When it arrives, call confirm_received; if something is wrong (missing, damaged, not as described, late), call open_case."
          : d.order_status === "delivered"
            ? "Delivered. If there's a problem, call open_case while the dispute window is open; otherwise nothing to do."
            : "Nothing to do yet; the seller ships next. Call get_order again later.",
      ),
  );

  const confirm_received = server.tool(
    {
      name: "confirm_received",
      title: "Confirm I received my order",
      description: "Buyer: confirm a shipped order arrived in good condition. Only call this when the human says so.",
      inputSchema: z.object({ order_id: id("order") }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ order_id }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/orders/${seg(order_id)}/received`, body: {}, idempotencyKey: deriveIdempotencyKey("confirm_received", order_id, undefined, {}) },
        BUYER_ORDER,
        { statusKey: "order_status" },
        () => "Marked delivered. If a problem shows up later, open_case still works while the dispute window is open.",
      ),
  );

  const open_case = server.tool(
    {
      name: "open_case",
      title: "Report a problem with an order",
      description:
        "Buyer: report a problem with a paid order — not_received, not_as_described, damaged, missing_item, late, wrong_item, changed_mind or duplicate_charge. Facts the platform can verify are settled automatically (e.g. no delivery scan after the seller's window means an automatic refund; a late delivery scan means a delivery-fee credit); otherwise the seller (or their agent) responds within their resolution policy, like a negotiation. Optionally ask for a specific remedy. " +
        REMEDY_DOC,
      inputSchema: z.object({
        order_id: id("order"),
        type: z.enum(CASE_TYPES).describe("What went wrong."),
        description: z.string().min(1).max(1000).describe("What happened, in the buyer's words."),
        items: z.array(itemRef).optional().describe("The affected items (default: the whole order)."),
        evidence: z.array(evidence).max(10).optional().describe("Optional supporting evidence."),
        requested_remedy: remedy.optional().describe("Optional: the remedy the buyer asks for. A request inside the seller's policy is accepted automatically."),
      }),
      outputSchema: resultSchema,
      annotations: { ...mutation, idempotentHint: false },
    },
    async ({ order_id, ...body }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/orders/${seg(order_id)}/cases`, body, idempotencyKey: deriveIdempotencyKey("open_case", order_id, undefined, body) },
        BUYER_ORDER,
        { statusKey: "case_status" },
        caseNext,
      ),
  );

  const add_evidence = server.tool(
    {
      name: "add_evidence",
      title: "Add evidence to a case",
      description: "Buyer or seller: attach evidence to an open problem case — a photo URL, a measurement (\"width 50in\"), a statement, or a tracking reference.",
      inputSchema: z.object({ case_id: id("case"), ...evidence.shape }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ case_id, ...body }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/cases/${seg(case_id)}/evidence`, body, idempotencyKey: deriveIdempotencyKey("add_evidence", case_id, undefined, body) },
        CASE,
        { statusKey: "case_status" },
        () => "Evidence saved on the case; both sides can see it. Call get_case to review the case.",
      ),
  );

  const respond_to_case = server.tool(
    {
      name: "respond_to_case",
      title: "Respond to a problem case",
      description:
        "Buyer or seller: respond to an open problem case when it is your turn — accept the current proposal, counter with a different remedy, or decline. Works like a negotiation: pass the case version you read as expected_version. Cases that go past the round limit, or where the two sides' policies can't overlap, are escalated to a person. " +
        REMEDY_DOC,
      inputSchema: z.object({
        case_id: id("case"),
        expected_version: z.number().int().min(0).describe("The case `version` you last read with get_case."),
        action: z.enum(["accept", "counter", "decline"]).describe("accept the other side's latest proposal, counter with your own remedy, or decline."),
        remedy: remedy.optional().describe("Required when action is counter."),
        note: z.string().max(500).optional().describe("One short sentence to the other side. Never share private limits."),
        idempotency_key: z.string().min(8).max(200).optional().describe("Optional. Leave empty: a deterministic key is derived from the call."),
      }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ case_id, expected_version, idempotency_key, ...rest }, ctx) => {
      const body = { expected_version, ...rest };
      return runTool(
        ctx as CallContext,
        { method: "POST", path: `/cases/${seg(case_id)}/respond`, body, idempotencyKey: idempotency_key ?? deriveIdempotencyKey("respond_to_case", case_id, expected_version, body) },
        CASE,
        { statusKey: "case_status" },
        caseNext,
      );
    },
  );

  const get_case = server.tool(
    {
      name: "get_case",
      title: "Get problem case",
      description: "Buyer or seller: open a problem case's panel — its type, status and whose turn it is, every proposal and counter, evidence, a substitute check for out-of-stock replacements, and any refunds. Use its version as expected_version for respond_to_case.",
      inputSchema: z.object({ case_id: id("case") }),
      outputSchema: resultSchema,
      view: { name: "case-detail", description: "Exchangent problem case", prefersBorder: true },
      annotations: readOnly,
    },
    async ({ case_id }, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: `/cases/${seg(case_id)}` }, CASE, { statusKey: "case_status" }, caseNext),
  );

  // ---------------------------------------------------------------------------
  // Seller
  // ---------------------------------------------------------------------------

  const list_orders = server.tool(
    {
      name: "list_orders",
      title: "List my business's orders",
      description: "Seller: list your business's paid orders — what to ship, what is in transit or delivered, refunds, and open problem cases. Buyers' emails are never shown.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    async (_input, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: "/seller/orders" }, SELLER_ORDERS, { listKey: "orders" }, (d) =>
        Array.isArray(d.orders) && d.orders.length === 0
          ? "No paid orders yet."
          : "Ship confirmed orders with mark_shipped; answer problem cases with list_cases and respond_to_case.",
      ),
  );

  const mark_shipped = server.tool(
    {
      name: "mark_shipped",
      title: "Mark an order shipped",
      description: "Seller: record that a paid order shipped, with the carrier and tracking reference. The buyer is notified.",
      inputSchema: z.object({
        order_id: id("order"),
        carrier: z.string().min(1).max(100).describe("Carrier name, e.g. \"UPS\" or \"Local courier\"."),
        tracking: z.string().min(1).max(200).describe("Tracking number or reference."),
      }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ order_id, ...body }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/seller/orders/${seg(order_id)}/ship`, body, idempotencyKey: deriveIdempotencyKey("mark_shipped", order_id, undefined, body) },
        SELLER_ORDER,
        { statusKey: "order_status" },
        () => "Shipped. Delivery is recorded by a carrier scan or the buyer's confirmation.",
      ),
  );

  const simulate_delivery = server.tool(
    {
      name: "simulate_delivery",
      title: "Simulate delivery (testing only)",
      description: "Seller, TEST MODE ONLY: record a simulated carrier delivery scan for a shipped order, because real carrier tracking isn't connected yet. The order is clearly labelled as a simulated scan. Refused outside the Stripe sandbox.",
      inputSchema: z.object({ order_id: id("order") }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ order_id }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/seller/orders/${seg(order_id)}/simulate-delivery`, body: {}, idempotencyKey: deriveIdempotencyKey("simulate_delivery", order_id, undefined, {}) },
        SELLER_ORDER,
        { statusKey: "order_status" },
        () => "Recorded a simulated delivery scan (testing only). The buyer's dispute window starts now.",
      ),
  );

  const report_fulfilment_issue = server.tool(
    {
      name: "report_fulfilment_issue",
      title: "Report a fulfilment problem",
      description:
        "Seller: report that you can't fulfil a paid order as agreed. kind=out_of_stock with a substitute proposes a replacement item — the platform checks it against the buyer's original requirements and price, and the buyer (or their agent) can accept it; without a substitute the buyer is refunded for the missing items. kind=address_problem asks the buyer to sort out delivery.",
      inputSchema: z.object({
        order_id: id("order"),
        kind: z.enum(["out_of_stock", "address_problem"]).describe("What went wrong."),
        items: z.array(itemRef).optional().describe("The affected items (default: the whole order)."),
        substitute: z.object({ inventory_id: z.string().min(1), quantity: z.number().int().positive(), replaces: z.string().min(1).optional().describe("inventory_id of the order item it replaces (from get_order). Optional when items lists exactly one item.") }).optional().describe("For out_of_stock: the item you offer instead (from get_inventory)."),
        note: z.string().max(500).optional().describe("One short sentence to the buyer."),
      }),
      outputSchema: resultSchema,
      annotations: { ...mutation, idempotentHint: false },
    },
    async ({ order_id, ...body }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/seller/orders/${seg(order_id)}/issue`, body, idempotencyKey: deriveIdempotencyKey("report_fulfilment_issue", order_id, undefined, body) },
        SELLER_ORDER,
        { statusKey: "case_status" },
        caseNext,
      ),
  );

  const list_cases = server.tool(
    {
      name: "list_cases",
      title: "List problem cases",
      description: "Seller: list problem cases on your business's orders — open ones waiting for your response first. Your seller agent answers cases for you when agent negotiation is on.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    async (_input, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: "/seller/cases" }, SELLER_ORDERS, { listKey: "cases" }, (d) =>
        Array.isArray(d.cases) && d.cases.length === 0
          ? "No problem cases."
          : "Open a case with get_case, then respond_to_case when it is your turn.",
      ),
  );

  const confirm_return = server.tool(
    {
      name: "confirm_return",
      title: "Confirm a returned item arrived",
      description: "Seller: confirm that a returned item arrived, for a case resolved with return_for_refund. This issues the buyer's refund (minus any restocking fee in your policy).",
      inputSchema: z.object({ case_id: id("case") }),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async ({ case_id }, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "POST", path: `/cases/${seg(case_id)}/return-received`, body: {}, idempotencyKey: deriveIdempotencyKey("confirm_return", case_id, undefined, {}) },
        SELLER_CASE,
        { statusKey: "case_status" },
        caseNext,
      ),
  );

  const policyFields = {
    auto_refund_not_received_after_days: z.number().int().min(0).max(60).optional().describe("Refund automatically when there's no delivery scan this many days after the delivery deadline (default 3)."),
    max_auto_partial_refund_pct: z.number().int().min(0).max(100).optional().describe("Accept a buyer's partial-refund or keep-with-discount request automatically up to this percent of the order (default 15)."),
    return_window_days: z.number().int().min(0).max(90).optional().describe("Days after delivery a buyer may return for a change of mind (default 14)."),
    restocking_fee_pct: z.number().int().min(0).max(50).optional().describe("Restocking fee kept on change-of-mind returns (default 0)."),
    seller_pays_return_shipping_when_at_fault: z.boolean().optional().describe("You pay return shipping when the problem was yours (default true)."),
    price_protection_days: z.number().int().min(0).max(60).optional().describe("Refund the difference if you sell the same thing cheaper within this many days (default 0 = off)."),
    fight_chargebacks_above_cents: z.number().int().min(0).optional().describe("Contest bank chargebacks above this amount (integer US cents, default 5000); smaller ones are accepted."),
  };

  const get_resolution_policy = server.tool(
    {
      name: "get_resolution_policy",
      title: "Get my resolution policy",
      description: "Seller: show the rules that settle problems automatically for your business — automatic refunds when nothing was delivered, how much partial refund to grant without asking, return window, restocking fee, price protection and when to contest chargebacks.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      annotations: readOnly,
    },
    async (_input, ctx) =>
      runTool(ctx as CallContext, { method: "GET", path: "/seller/policy" }, POLICY, {}, () =>
        "These rules apply to every case on your orders; change them with set_resolution_policy.",
      ),
  );

  const set_resolution_policy = server.tool(
    {
      name: "set_resolution_policy",
      title: "Set my resolution policy",
      description: "Seller (owner only): change the rules that settle problems automatically for your business. Send only the fields to change.",
      inputSchema: z.object(policyFields),
      outputSchema: resultSchema,
      annotations: mutation,
    },
    async (body, ctx) =>
      runTool(
        ctx as CallContext,
        { method: "PUT", path: "/seller/policy", body, idempotencyKey: deriveIdempotencyKey("set_resolution_policy", undefined, undefined, body) },
        POLICY,
        {},
        () => "Policy saved; it applies to new cases. Call get_resolution_policy to review it.",
      ),
  );

  return {
    list_my_orders, get_order, confirm_received, open_case, add_evidence, respond_to_case, get_case,
    list_orders, mark_shipped, simulate_delivery, report_fulfilment_issue, list_cases, confirm_return, get_resolution_policy, set_resolution_policy,
  };
}
