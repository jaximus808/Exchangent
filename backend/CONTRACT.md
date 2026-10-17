# Backend integration contract

Implementation target for the backend and payments owner. Request creation,
request/offer reads, seller activity, reservations, checkout and delegation
endpoints exist in the authenticated local API. See `API.md` for exact implemented
routes; the remaining table entries are future targets. See `SETUP.md` and
`PROOF.md` for environment and verified payment results. The shared architecture
reference is `doc/architecture.md`.

## Ownership

- Backend and payments: `backend/`, InsForge schema and migrations, API rules,
  matching, inventory holds, Stripe Checkout and webhook handling.
- Teammate: MCP tools, agent worker, Inkbox transport and model behavior.
- Coordinate the Next.js scaffold before creating a root package or routes.
  Backend modules should be callable from Next.js route handlers without duplicating rules.
- Primitive sending is a backend side effect; the worker may consume verified
  inbound events, but agents cannot bypass the backend to send purchase confirmations.

## Demo boundaries

USD, San Francisco, three fictional sellers, one seller per desk-and-chair bundle.
Payment uses Stripe sandbox Checkout. Exchangent demo charges belong to one test
merchant; seller payouts and Stripe Connect are not implemented in this milestone.
Buyer payment approval happens in hosted Checkout. A budget authorizes negotiation,
not spending. No personal Link connection, issued cards or stored card details.

## Shared conventions

- IDs are UUID strings; Stripe IDs remain Stripe strings. Times are UTC ISO 8601.
- Money is positive integer cents. Each offer stores item subtotal, delivery,
  demo tax and total, all in cents. Total is computed and validated on the server.
  Demo tax is explicit sample data, not a tax calculation service.
- Every request carries a verified principal with buyer, seller or worker scope.
  Never trust buyer ID, seller ID or role supplied by the model as authorization.
- Mutations require `Idempotency-Key`; keys are scoped to principal and operation.
  Reuse with a different body returns `idempotency_conflict`.
- Success: `{ data: ... }`. Failure: `{ error: { code, message, next_action } }`.
- Common errors: `unauthorized`, `forbidden`, `invalid_input`, `stale_offer`,
  `offer_expired`, `out_of_stock`, `budget_exceeded`, `below_floor`,
  `idempotency_conflict`, `reservation_expired`, `payment_pending`.
- Buyer responses never contain seller floors or other sellers' private data.
  Seller responses never contain the buyer's ceiling. Dashboard projections use
  the same redaction rules. Private fields never enter an outbox event or analytics.

## Data model

| Entity | Required fields and rules |
| --- | --- |
| Seller | ID, owner user ID, name, service area, enabled |
| Inventory | ID, seller ID, SKU, title, attributes, quantity; unique seller and SKU |
| Seller policy | Seller ID, private item floors and allowed concessions, version |
| Buy request | ID, buyer user ID, requirements, private total ceiling, currency, deadline, status |
| Negotiation session | ID, request ID, seller ID, latest offer ID, version, status; unique request and seller |
| Offer | ID, session ID, author principal, responding-to ID, immutable line items and totals, version, expiry |
| Reservation | ID, request ID, offer ID and version, held items, status, expiry, Stripe session ID |
| Order | ID, reservation ID, buyer ID, seller ID, immutable purchase snapshot, payment status; unique reservation |
| Inbox event | Provider and event ID, recipient, payload, processing state; unique provider and event ID |
| Outbox event | ID, kind, aggregate ID, redacted payload, attempts, next attempt, delivery state |
| Payment event | Unique Stripe event ID, session ID, processing result |
| Mutation key | Principal, operation, key, request hash, persisted result |

All writes go through backend operations. Private tables have no anonymous access.
Inventory holds, offer version updates, idempotency records and outbox inserts
must be transactional, not a sequence of unrelated SDK CRUD calls.

## Proposed API boundary

All paths are under `/api/v1`. The worker uses scoped credentials, not an InsForge
admin key. Actual auth wiring must be agreed before endpoints are exposed.

| Method and path | Caller and behavior |
| --- | --- |
| `POST /buy-requests` | Buyer: requirements, ceiling, deadline; save request and matching job atomically |
| `GET /buy-requests/:id` | Owning buyer: redacted status and progress |
| `GET /buy-requests/:id/offers` | Owning buyer: current eligible offers |
| `POST /sessions/:id/offers` | Participating agent: responding-to ID, items, proposed totals, note; validate authority, policy, constraints and version; save offer plus delivery event |
| `POST /offers/:id/decline` | Participating agent: close the offer response with an optional reason |
| `POST /offers/:id/reservations` | Owning buyer or delegated buyer worker: select a seller-authored offer and atomically hold stock; does not charge |
| `POST /reservations/:id/checkout` | Owning buyer or delegated worker: create or return one test Checkout Session from the saved offer; no caller-supplied price |
| `GET /orders/:id` | Owning buyer or corresponding seller: authorized order projection |
| `PATCH /sellers/:id/policy` | Verified owner: update private policy with expected version |

MCP `create_buy_order` maps to creating a buy request; it does not create a paid
order. Agent `accept_offer` maps to selection/reservation only. Acceptance by a
seller creates a seller-authorized offer before the buyer can reserve it.
`approve_offer` must not imply that the agent can approve payment for the human.

## Reservation and payment rules

1. Validate the current offer, seller authorization, item quantities, buyer
   requirements, all-in budget and expiry. Reserve all bundle items atomically.
   Only one active reservation is allowed per buy request.
2. Hold stock for a Checkout-compatible window of at least 30 minutes. Reject a
   Checkout creation attempt if insufficient hold time remains; renew the hold
   transactionally or return an actionable expiration error first.
3. Create Checkout with a reservation-specific idempotency key. Persist the session
   ID and use only server-owned return URLs. A retry after a crash reuses the same
   Stripe operation; it cannot create a second purchase.
4. Verify the raw Stripe webhook body and signature. Check test mode, session ID,
   reservation binding, currency and amount against the purchase snapshot.
   A browser redirect or email reply is never payment proof.
5. Handle completed and async-payment-success events. Confirm only when paid;
   completed-but-unpaid becomes `payment_pending` and keeps its stock allocation
   until the provider reports success or failure. No premature stock release.
6. Record the event, confirm the order, consume stock and enqueue confirmation in
   one transaction. Duplicate and out-of-order events cannot double-fulfill or
   change a confirmed order back to expired.
7. Before releasing an abandoned hold, reconcile/expire its Stripe session.
   An active or ambiguous payment cannot race with stock being resold. A paid
   session discovered after local expiry requires reconciliation, not silent loss.
8. Renegotiation creates new immutable offers. A replacement checkout cannot
   become payable until the old session and reservation are safely retired.

Request: `negotiating -> awaiting_payment -> confirmed`, with separate cancelled
and expired outcomes. Reservation: `held -> checkout_open -> payment_pending -> consumed`,
or safely expired/cancelled. Order payment and physical fulfillment are separate;
payment confirmation never means the furniture has been delivered.

## Durability and acceptance checks

- Persist signed inbound messages with a unique provider event ID before ACK.
  Workers claim jobs with leases; restart recovers unprocessed jobs.
- Offers and outbox delivery events commit together; delivery retries use a stable
  message ID and receiver deduplication even if transport deduplication is unavailable.
- Two simultaneous buyers cannot reserve the same last item.
- A retry cannot create duplicate offers, holds, Checkout Sessions or orders.
- Wrong role, below-floor, over-budget, stale and expired requests fail safely.
- Invalid webhook signatures and amount/currency/session mismatches cannot confirm.
- Paid events confirm exactly once; pending, failed and expired payments reconcile.
- Closing the originating chat has no effect once the request is durably accepted.

## First milestone

Completed: create the schema, insert explicit demo fixtures, reserve a fixed offer,
create a test Checkout Session and confirm it through a verified webhook. Next connect
agent-generated offers to the same operations. No model calls are needed to test
the transaction lifecycle.
