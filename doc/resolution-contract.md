# Resolution, chargebacks and email-your-agent: build contract

The design is in `doc/resolution-design.md`. Depends on `migrations/20261018000800_hardening.sql`
(doc/hardening-contract.md), which owns `commerce_apply_payment` and adds `commerce_orders.stripe_payment_intent`.

## Database: `migrations/20261018000900_resolution.sql`

Additive only. Do **not** re-create `commerce_apply_payment`.

**Orders.** `commerce_orders` gains:
- `status` values `confirmed | shipped | delivered | closed | cancelled | refunded`;
- `refunded_cents int NOT NULL DEFAULT 0`;
- `carrier`, `tracking`, `shipped_at`, `delivered_at`, and `delivery_evidence jsonb` (`{source: 'carrier' | 'simulated' | 'buyer_confirmed', at}`);
- `dispute_window_ends_at` (`delivered_at` + the policy's return window, or 14 days).

**`commerce_resolution_policies`** has one row per seller. A missing row means the defaults (and the getter returns them):

| Field | Default |
|---|---|
| `auto_refund_not_received_after_days` | 3 |
| `max_auto_partial_refund_pct` | 15 |
| `return_window_days` | 14 |
| `restocking_fee_pct` | 0 |
| `seller_pays_return_shipping_when_at_fault` | true |
| `price_protection_days` | 0 |
| `fight_chargebacks_above_cents` | 5000 |

**`commerce_cases`:**
- **Identity:** `id`, `order_id`, `request_id`, `buyer_id`, `seller_id`.
- **Opened:** `opened_by` (`buyer | seller | platform`) and `type`, one of `not_received`, `not_as_described`,
  `damaged`, `missing_item`, `late`, `wrong_item`, `changed_mind`, `duplicate_charge`, `substitution`.
- **Lifecycle:** `status` (`open | resolved | escalated | closed`), `turn` (`buyer | seller`), `version`, `rounds`.
- **Content:** `items jsonb` (reservation item IDs and quantities), `description` (≤ 1000), `evidence jsonb[]` (each
  `{kind: photo | measurement | text | tracking, ref, at, by}`), and `resolution jsonb` (the accepted remedy plus
  `how: auto | agreed | policy`).
- **Timestamps:** `created_at`, `updated_at`.

**`commerce_case_moves`** records each move: `by`, `action` (`open | offer | accept | decline | auto | escalate`),
`remedy jsonb`, `note` (≤ 500), `version` and `created_at`.

**`commerce_refunds`:**
- `id`, `order_id`, `case_id`, `amount_cents`, `reason`;
- `status` (`pending | succeeded | failed`), `stripe_refund_id`, `created_at`;
- uniqueness on `case_id` where it's not null.

**`commerce_disputes`:**
- `id`, `order_id`, `stripe_dispute_id` (unique), `reason`, `amount_cents`, `status`;
- `decision` (`fight | accept`), `evidence jsonb`, `submitted_at`, `created_at`.

**Remedy:**
`{kind: refund_full | refund_partial | refund_items | replace | return_for_refund | keep_with_discount | sla_credit | cancel, amount_cents?, items?, substitute?: {inventory_id, quantity}, return_shipping_paid_by?: buyer | seller}`.
- **Validation:** the backend computes and caps every amount at `total_cents - refunded_cents`. `refund_items` uses the
  reservation item snapshots exactly.
- **When the money moves:**
  - `keep_with_discount`, `refund_partial`, `refund_full`, `refund_items`, `sla_credit` and `cancel` (only before it
    ships): a refund, on acceptance.
  - `return_for_refund`: the refund happens when the seller calls `confirm_return`.
  - `replace`: no money. The order gets a replacement shipment, and `mark_shipped` can be called again.

**SQL functions** (`project_admin` only, raise snake_case codes):
- **Fulfilment:**
  - `commerce_mark_shipped(seller, order, carrier, tracking)` sends a confirmed order to `shipped`.
  - `commerce_simulate_delivery(actor, order)` (labelled simulated) and `commerce_confirm_received(buyer, order)` both
    send a shipped order to `delivered`.
- **`commerce_open_case(actor, scope, order, type, items, description, evidence, requested_remedy)`** first applies the
  auto rules in order:
  - **`not_received`:** no `delivered_at`, and now is later than (deadline, or `shipped_at`) + the policy days → auto
    refund for the case's items (all items if none are given).
  - **`late`:** `delivered_at` after the request deadline → automatic `sla_credit` equal to the offer's delivery cents.
  - **`duplicate_charge`:** another confirmed order by the same buyer and seller, same total, within 10 minutes → auto
    full refund of the newer order.
  - **`changed_mind`:** outside `return_window_days` → automatic decline. Inside it → `return_for_refund`, minus
    restocking.
  - **A buyer request inside the seller's policy:** `requested_remedy` of `refund_partial` or `keep_with_discount`
    at or below `max_auto_partial_refund_pct` → accepted under policy.
  - **Otherwise** the case opens with the turn on the other party.

  The function returns the case JSON plus `refunds_to_execute: [{refund_id, amount_cents}]`.
- **`commerce_respond_case(actor, scope, case, expected_version, action, remedy, note)`:**
  - Version and turn work like negotiations.
  - **The round cap is 6.** After that the case is `escalated`, with a `case.escalated` event.
  - **Seller offers are capped** at the refundable amount. The buyer can counter.
  - **Accept** applies the remedy and returns `refunds_to_execute`.
- **Supporting functions:**
  - `commerce_add_evidence(...)`;
  - `commerce_confirm_return(seller, case)` refunds after a `return_for_refund`;
  - `commerce_refund_result(refund, status, stripe_id)` updates `refunded_cents` and the order status;
  - `commerce_report_fulfilment_issue(seller, order, kind, substitute)`.
- **`kind=out_of_stock` with a substitute** opens a `substitution` case by the seller, with remedy `replace`. The case
  JSON includes `substitute_check: {meets_requirements, unit_cents_delta, category}`, worked out with
  `commerce_item_matches` against the original request's requirement for that category. Accepting it swaps the
  reservation and order items and adjusts inventory. A cheaper substitute refunds the difference.
- **`kind=out_of_stock` with no substitute** opens a case with remedy `refund_items`. Address problems open a case
  for the buyer.
- **Reads:**
  - `commerce_case_json(case)`;
  - `commerce_cases_for(actor, scope, seller)`;
  - `commerce_get_policy(seller)` and `commerce_set_policy(seller, patch)`.
- **Disputes:**
  - `commerce_record_dispute(stripe_dispute_id, payment_intent, reason, amount, status)` finds the order by
    `stripe_payment_intent`.
  - `commerce_dispute_evidence(order)` returns facts only:
    - the negotiation transcript (the conversation messages),
    - the human approval (reservation created and checkout session created, with timestamps, plus the Stripe session
      ID),
    - shipping (carrier, tracking, delivered evidence),
    - the attribute contract (the offer items' attributes),
    - cases and refunds.

**Outbox / worker-feed events** (worker feed, same route shape):

| Event | Goes to |
|---|---|
| `order.shipped` | buyer |
| `order.delivered` | buyer |
| `case.opened` | the party whose turn it is |
| `case.offer` | the other party |
| `case.resolved` | both: `to_role` buyer and seller, as two rows |
| `case.escalated` | both |
| `refund.succeeded` | buyer |
| `dispute.created` | seller |
| `dispute.decided` | seller |

- **Payloads:** IDs plus `type`, `status`, `remedy` kind and amount, and `title`. Never budgets, floors or emails.
- **Delegation:** route fields include `delegated` and `seller_delegated`, so the runner knows whether an agent acts
  for that side.

## Backend routes

All responses are `{data}`. Money-moving routes execute `refunds_to_execute` after the DB call:
1. `stripe.refunds.create({payment_intent, amount}, {idempotencyKey: 'exchangent-refund-'+refund_id})`.
2. `commerce_refund_result`.

A Stripe failure marks the refund `failed`, returns `refund_failed` (502) and can be retried.

**Buyer** (role or connector buyer, and `buyer_agent` for delegated requests' cases; the agent gets no
`confirm_received`):

| Route | Purpose |
|---|---|
| `GET /orders?` | The buyer's orders |
| `GET /orders/:id` | One order, with its status, shipping, cases and refunds |
| `POST /orders/:id/received` | `confirm_received` |
| `POST /orders/:id/cases` | Opens a case. Body: `type`, `items`, `description`, `evidence`, `requested_remedy` |
| `GET /cases/:id` | One case |
| `POST /cases/:id/respond` | `{expected_version, action, remedy?, note?}` |
| `POST /cases/:id/evidence` | Adds evidence |

**Seller:**

| Route | Purpose |
|---|---|
| `GET /seller/orders` | The seller's orders. The buyer is shown only as a `shipping_name` placeholder; no email. |
| `POST /seller/orders/:id/ship` | `{carrier, tracking}` |
| `POST /seller/orders/:id/simulate-delivery` | Test mode only (Stripe key is `sk_test`). Returns `simulated: true`. |
| `POST /seller/orders/:id/issue` | Reports a fulfilment problem |
| `GET /seller/cases` | The seller's cases |
| `GET /cases/:id` | One case |
| `POST /cases/:id/respond` | Responds to a case |
| `POST /cases/:id/return-received` | `confirm_return` |
| `GET /seller/policy` | Reads the resolution policy |
| `PUT /seller/policy` | Owner only; agent tokens get 403 |

**User session (web):** `GET /api/v1/orders` (buyer), `GET /api/v1/businesses/:id/orders` and
`GET /api/v1/businesses/:id/cases` (owner).

**Worker:** `GET /worker/buyer-requests?email=<addr>` returns the delegated, non-closed requests whose buyer has that
exact email:
`[{request_id, title, status, best_offer:{seller_name,total_cents}|null, sessions_open, watch_path:'/watch/<id>'}]`.
It never includes budgets or other people's data. The email-your-agent feature uses it.

**Stripe webhook** (`commerce.ts` `webhook()`), in addition to the checkout events:
- **`charge.dispute.created`:**
  1. `commerce_record_dispute`, then decide: **fight** if the order has delivered evidence **or** the dispute reason
     is `fraudulent` or `unrecognized` (a human approved the payment) **and** the amount is at or above the policy's
     `fight_chargebacks_above_cents`. Otherwise **accept** (`stripe.disputes.close`).
  2. When fighting, `stripe.disputes.update(id, {evidence: {...}, submit: true})`, using these fields:
     - `product_description`;
     - `customer_communication`: the transcript text;
     - `uncategorized_text`: the human-approval statement plus timestamps;
     - `shipping_carrier`, `shipping_tracking_number`, `shipping_date`;
     - `refund_policy`: from the policy;
     - `service_date`.
  3. Write the `dispute.decided` event.
- **Other events:** `charge.dispute.closed` updates the status. `charge.refunded` reconciles `refunded_cents` and is
  idempotent.
- **Test mode:** the live-mode guard stays.

**The Stripe webhook endpoint needs these events enabled:** `charge.dispute.created`, `charge.dispute.closed` and
`charge.refunded`, besides the four checkout events. Put this in SETUP.md. The local `local-server.ts` fake should
simulate refunds and disputes (`POST /__dispute/<order_id>`).

## MCP tools (`mcp/`)

**Buyer:** `list_my_orders`, `get_order`, `confirm_received`, `open_case`, `add_evidence`, `respond_to_case`, `get_case`.

**Seller:** `list_orders`, `mark_shipped`, `simulate_delivery` (its description says it's for testing), `report_fulfilment_issue`, `list_cases`, `get_case`, `respond_to_case`,
`confirm_return`, `get_resolution_policy`, `set_resolution_policy`.

**Descriptions** explain the remedy object in one paragraph, and that amounts are capped by the backend.

**Views:**
- an order/case panel: a timeline of shipping, then the case moves as bubbles, then refunds;
- reuse the conversation bubble styles.

## Web (`web/`)

- **Buying:** each order shows its status timeline (paid → shipped → delivered), "Report a problem" (opens a case
  with type, items and description), its cases and their moves, and refunds.
- **Selling:** orders to ship ("Mark shipped", and "Simulate delivery" in test mode), cases to answer (accept, or a
  counter with a remedy), and a resolution policy editor.

## Agents (`agents/`)

**Case events:**
- `case.opened` / `case.offer` to the buyer: a brain turn for the buyer agent when `route.delegated`.
- `case.opened` / `case.offer` to the seller: a turn for the seller agent when `route.seller_delegated`.
- The personas get case rules:
  - **Buyer:** aim for a fair remedy, accept a substitution only when `substitute_check.meets_requirements` and the
    delta is ≤ 0, and never request more than the item's value.
  - **Seller:** stay within `max_auto_partial_refund_pct` + 10 for counters, and prefer keep-with-discount over a
    return for bulky items.
- Notes are untrusted.

**Emails** go from Inkbox, once each, with an idempotency key:
- **To the buyer:** `order.shipped`, `case.resolved` (what was agreed, plus the refund), `refund.succeeded`.
- **To the seller owner:** `case.opened` when the seller negotiates by hand, `case.escalated`, `dispute.created` and
  `dispute.decided`.

**Email your agent:** inbound email to `exchangent-buyer` (and to a seller's identity, for that seller's owner):
1. Look up the sender's address with `/worker/buyer-requests?email=` for the buyer, or the business owner email for a
   seller.
2. Reply in the thread with a status summary: the best offer per request, open sessions, the order status, and the
   watch link `${EXCHANGENT_WEB_URL}/watch/<id>`.
3. **Read-only.** The reply always goes to the registered email for those requests, never to a Reply-To header, so a
   forged From learns nothing.
4. **Unknown senders** get a short "I only answer the account owner" reply, or nothing.
5. **Rate limits:** 10 replies per sender per hour.
6. **Ignored:** auto-replies, bounces, and mail from our own identities.

Use the Inkbox SDK's inbound mail support (check the SDK version in `agents/package.json`: webhook subscription to mail
events, or polling the mailbox). If the SDK can't receive mail, use polling with a cursor kept in `.state`.
