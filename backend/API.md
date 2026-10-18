# Authenticated commerce API handoff

The dashboard and Manufact MCP server call the same backend operations. No root
Next.js scaffold has been created, so the teammate's app layout remains separate.
The modules are reusable from Next.js handlers; `src/server.ts` is the local harness.

## Authentication

Send `Authorization: Bearer <token>`. Accepted credentials are:

1. **InsForge user access token.** The backend creates a fresh server-mode SDK
   client and asks InsForge to verify the current session. Only the verified user
   UUID is mapped to an application actor. Caller-supplied actor IDs and decoded,
   unverified JWT payloads are never trusted. Admin/CLI keys are not user sessions.
2. **Task delegation.** A signed-in human can issue an opaque `exg_` credential
   tied to one owned request or one owned seller, with explicit scopes and expiry.
   Only its SHA-256 digest is stored. The plaintext is returned once, must stay in
   a server-side secret store, and must not enter prompts, transcripts or logs.

3. **Connector access token (`exc_`).** Issued by the OAuth token endpoint below to
   the MCP server after a person approves the consent screen (`doc/oauth-contract.md`).
   It is bound to one actor and one role: the person's buyer account, or one business
   they own. It resolves to the same principal as a seeded role token
   (`{ scope: 'buyer', actor_id }` or `{ scope: 'seller', actor_id, seller_id }`), so it
   uses the negotiation routes in `doc/negotiation-contract.md`. It lasts 1 hour. It stops
   working when it expires, is rotated or revoked, or the seller grant's actor no longer
   owns that business. Refresh tokens (`exr_`) are never accepted as Bearer credentials.
   Only SHA-256 digests of either token are stored.

4. **Role tokens (64 hex).** Seeded or script-minted `commerce_principals` rows with scope
   `buyer`, `buyer_agent`, `seller` or `worker`. They use the negotiation routes. The platform
   buyer agent (`buyer_agent`) is described under [Buyer agent](#buyer-agent).

Delegations last 5 minutes to 24 hours (default 1 hour). Humans can revoke them.
Every API call rechecks expiry and revocation. A delegated agent cannot issue or
revoke credentials, create new buy requests or broaden its own authority.
Workers need explicit delegation renewal for tasks longer than 24 hours; do not
copy a user's refresh token into a sandbox to bypass this boundary.

The old `COMMERCE_DEMO_TOKEN` is rejected. Private tables and RPC functions remain
inaccessible to both anonymous and ordinary authenticated database clients. The
API's server-only admin client is the trusted business-rule boundary.

## Implemented routes

All responses use `{ data: ... }` or `{ error: { code, message, next_action } }`.
No responses are cached. The harness listens on loopback port 8787 by default.

| Method and route | Access and result |
| --- | --- |
| `GET /api/v1/me` | Verified actor, credential kind and delegated scope/binding |
| `POST /api/v1/buy-requests` | User session only; create an idempotent request and durable matching event |
| `GET /api/v1/buy-requests/:id` | Owner or request-bound `request:read`; redacted request status |
| `GET /api/v1/buy-requests/:id/offers` | Same; bounded current seller offers with item prices and total |
| `GET /api/v1/sellers/:id/activity` | Owner or seller-bound `seller:read`; offers and confirmed orders |
| `POST /api/v1/offers/:id/reservations` | Owner or request-bound `reservation:write`; atomic inventory hold |
| `POST /api/v1/reservations/:id/checkout` | Owner or request-bound `checkout:write`; hosted test payment link |
| `GET /api/v1/reservations/:id` | Owner or request-bound `request:read`; reservation and confirmed order |
| `POST /api/v1/delegations` | User session only; issue a credential for an owned request or seller |
| `DELETE /api/v1/delegations/:id` | User session only; revoke an owned credential |
| `POST /webhooks/stripe` | Raw body verified with Stripe signature; no user Bearer token. A confirmed order also emails the buyer once via Primitive when configured (`SETUP.md`); email errors never change the response |
| `GET /api/v1/oauth/targets?client_id&redirect_uri` | User session only; consent screen data (below) |
| `POST /api/v1/oauth/authorize` | User session only; issue a single-use authorization code (below) |
| `POST /api/v1/oauth/token` | OAuth client authentication; RFC 6749 token endpoint (below) |

Negotiation request and offer reads optionally include `opening_total_cents` for
each seller, taken from its first recorded offer (including delivery and tax),
after checking request access. This is a historical comparison, not a list price
or private seller minimum. Offer reads retain the seller's delivery-day estimate.
Reservation status also includes `request_id`, allowing the client to return to
current offers after a hold ends. An expired checkout attempt releases only stale
holds with no attempted Stripe session; ambiguous or bound sessions are preserved
for payment reconciliation.

Request creation takes:

```json
{"requirements":"Desk and chair delivered Saturday","budget_cents":40000,"currency":"usd"}
```

Send `Idempotency-Key` on request creation and offer reservation. Different input
with the same creation key is rejected. `request.created` is queued atomically;
the matcher/outbox consumer is not implemented yet. Creating a request alone does
not imply that a negotiation worker has started.

Request delegation example (the ID must be a real owned request):

```json
{"request_id":"REQUEST_UUID","scopes":["request:read","reservation:write","checkout:write"],"ttl_seconds":3600}
```

Seller delegation example:

```json
{"seller_id":"SELLER_UUID","scopes":["seller:read"],"ttl_seconds":3600}
```

Only pass the capabilities the worker needs. Creating a checkout link is not
permission to pay; human approval remains in hosted Stripe Checkout. Seller
delegation is read-only in this phase; offer/policy mutations remain future work.

## Connector OAuth

Spec: `doc/oauth-contract.md`. Code: `src/oauth.ts`. Schema and RPCs:
`migrations/20261018000200_connector-oauth.sql`. Delegations, connector tokens and
role tokens get `403 user_session_required` from the two consent routes.

- **`GET /api/v1/oauth/targets?client_id=...&redirect_uri=...`** returns
  `{ data: { client: { client_id, name }, account: { actor_id, email }, businesses: [{ seller_id, name }] } }`.
  `email` comes from the verified InsForge user. `businesses` lists enabled sellers whose
  `owner_id` is the actor. An unknown or revoked client gives `400 invalid_client`. A
  `redirect_uri` that isn't an exact match for a registered one gives `400 invalid_redirect_uri`.
  A missing or repeated parameter gives `400 invalid_request`.
- **`POST /api/v1/oauth/authorize`** takes `{ client_id, redirect_uri, scope, state?, code_challenge,
  code_challenge_method: "S256", target: { kind: "buyer" } | { kind: "seller", seller_id } }`. It
  returns `{ data: { redirect_to } }`, which is `redirect_uri` plus `code` and `state`. The registered
  URI's own query string is kept, and no `iss` is added. **PKCE S256 is required**: a missing
  challenge or another method gives `400 invalid_request`. A seller the actor doesn't own,
  or one that is disabled or missing, gives `403 forbidden`. If `scope` names `buyer` or `seller`
  but not the chosen kind, the call gives `400 invalid_scope`. The code is stored as a SHA-256 hash,
  lasts 5 minutes and can be used once.
- **`POST /api/v1/oauth/token`** answers in plain RFC 6749 JSON, not the `{data}` envelope, with
  `Cache-Control: no-store` and `Pragma: no-cache`. The body is `application/x-www-form-urlencoded`
  (any `;charset` suffix) or JSON. The client authenticates with `client_id` and `client_secret` in
  the body or with HTTP Basic. Using both is allowed only if they match; otherwise the call gives
  `invalid_request`. Secrets are compared as SHA-256 digests in constant time.
  - `grant_type=authorization_code` takes `code`, `redirect_uri` and `code_verifier` (S256).
  - `grant_type=refresh_token` takes `refresh_token`. It rotates both tokens. If an already-rotated
    refresh token is presented again, every token in that grant is revoked. Replaying an
    authorization code also revokes the tokens it issued (RFC 6749 section 4.1.2).
  - A successful call returns `200 {"access_token":"exc_...","token_type":"Bearer","expires_in":3600,"refresh_token":"exr_...","scope":"buyer"|"seller"}`.
    Refresh tokens last 30 days, and each rotation starts a new 30 days.
  - Errors: `400 invalid_request | invalid_grant | unsupported_grant_type` (with `error_description`),
    or `401 invalid_client` with `WWW-Authenticate`.
- **`GET /api/v1/me`** with an `exc_` token returns
  `{ data: { kind: "connector", scope, actor_id, seller_id, client_id } }`.

Code redemption and refresh rotation each run in one SQL transaction that locks the code or
grant row. Concurrent requests therefore can't both receive tokens.

## Buyer agent

Migration: `migrations/20261018000400_buyer-agent.sql`. Code: `src/negotiation.ts` (`actingBuyer`, `canRead`).
One platform principal, scope `buyer_agent`, negotiates every request whose buyer left
`delegate_negotiation` on (the default; `POST /buy-requests` accepts `delegate_negotiation: false`).
It acts **as that request's buyer**: the same budget check, the same idempotency-key space, and
counters stored with the request's `buyer_id`. It can't do anything else.

`GET /api/v1/me` returns `{ scope: "buyer_agent", actor_id: <platform agent actor>, seller_id: null, label }`.

| Route (negotiation routes, `/api/v1`) | `buyer_agent` behaviour |
| --- | --- |
| `GET /buy-requests/:id` (MCP `get_buy_order`) | Full buyer view, including `budget_cents` and `target_cents`, plus `buyer_email`: the buyer's InsForge email, or `null` for demo actors without an account. Only the buyer agent gets `buyer_email`. Buyers don't get it, and sellers never do (it is also stripped from every seller view) |
| `GET /buy-requests/:id/offers` (`list_offers`) | Buyer view, as for the buyer |
| `GET /sessions/:id` | Buyer view (`role: "buyer"`) |
| `POST /sessions/:id/counters` (`counter_offer`) | As the buyer. `budget_exceeded`, `stale_offer`, `not_your_turn` and `session_closed` apply unchanged |
| `POST /sessions/:id/decline` (`decline_seller`) | As the buyer (`declined_by: "buyer"`) |
| Request with `delegate_negotiation = false` | `403 forbidden` on every route above. The message says that the buyer did not delegate negotiation of this request |
| Unknown request or session ID | `404 request_not_found` / `session_not_found`, the same as for a buyer |
| `POST /buy-requests`, reservations, checkout, reservation status, every `/seller/*` and `/worker/*` route, seller offers | `403 forbidden` ("Requires buyer scope; this token has buyer_agent scope") |

Role tokens have no list-my-requests route (`GET /buy-requests` is `404 not_found` for every role token).
The runner learns about requests from the worker feed. `GET /worker/events` routes now carry
`route.delegated` (boolean, the request's `delegate_negotiation`). The runner's buyer agent skips
events where it is `false`, because that buyer negotiates in chat.

SQL helpers (project_admin only, like the other RPCs):
- `commerce_delegated_buyer(p_request, p_session)` returns `{ request_id, buyer_id }`. It raises
  `forbidden` if the request isn't delegated.
- `commerce_delegated_buyer_email(p_request)` is a narrow `SECURITY DEFINER` function that reads
  `auth.users`. It returns `{ request_id, email }`, only for delegated requests.
- `commerce_rotate_agent_principals(p_principals, p_hours)` runs in one transaction. It revokes every
  earlier `agents:%` principal and inserts the new hashes. It refuses any label outside `agents:` and
  any scope other than `buyer_agent`, `seller` or `worker`.

### Minting runner tokens: `npm run agents:tokens`

`scripts/agent-tokens.ts` works against `DATABASE_URL` or InsForge (`backend/.env.local`). It is
additive: it never resets stock or prices and never touches the demo seed's `seed:%` principals, and
re-running `seed:negotiation` leaves its tokens alone. Each run:

- creates the platform buyer-agent actor (`seedId('buyer-agent')`, label "Exchangent buyer agent")
  and the worker actor if they are missing;
- revokes earlier `agents:%` tokens, then mints one `buyer_agent` token (`agents:buyer-agent`), one
  `worker` token (`agents:worker`) and one `seller` token per business (`agents:seller:<id>`). Each
  seller token acts as that business's current owner;
- writes `backend/.agent-principals.json` (mode 600, gitignored) in the runner's shape:
  `{ backend_url, buyer: { actor_id, token, scope: "buyer_agent" }, sellers: [{ seller_id, name, token }], worker: { token } }`.
  `backend_url` is `COMMERCE_BASE_URL`, defaulting to `http://127.0.0.1:8787`. Set
  `AGENT_PRINCIPALS_FILE` to write it elsewhere. Only a summary is printed, never tokens.

Options: repeat `--seller "<name or id>"` to choose businesses. The default is the three seeded demo
sellers; if they're missing, run `seed:negotiation` once first. `--hours N` sets the lifetime
(default 72, maximum 8760).

```sh
npm run agents:tokens --prefix backend
npm run agents:tokens --prefix backend -- --seller "Bay Desk Co" --seller <seller-uuid> --hours 24
```

## Businesses and the seller agent

Migration: `migrations/20261018000600_self-serve-signup.sql`. Code: `src/negotiation.ts`
(`registerBusiness`, `ownerOnly`, `mintSellerAgentToken`). Contract: `doc/signup-contract.md`.

Anyone who signs in can register a business they will own. No seeding is needed. A business matches
new buy requests as soon as it has stock in the request's region.

Each business has `delegate_negotiation`, the owner's "let my agent negotiate" setting (default `true`).
While it is on, the worker can mint a short-lived seller token for the platform seller agent.

| Route (`/api/v1`) | Who | Behaviour |
| --- | --- | --- |
| `POST /businesses` with an InsForge user session | Consent page "Create a business" | Body `{ name, service_area?, delivery_cents?, delivery_days? }`. **201** with the business JSON (below). The person becomes the owner. Delegation (`exg_`) tokens get `403 user_session_required` |
| `POST /businesses` with a buyer role or connector token | MCP `register_business` | Same body. **200** `{ business, next }`. `next` is "Reconnect Exchangent in your assistant and choose <name> to manage it." `buyer_agent`, `seller` and `worker` get `403 forbidden` |
| `GET /seller/business` | seller, including agent tokens | The business JSON |
| `PATCH /seller/business` | seller (the owner) | Any of `{ name, service_area, delivery_cents, delivery_days, delegate_negotiation }`. Any other key, such as `enabled`, is `400 invalid_input`. Turning `delegate_negotiation` off revokes the seller agent's tokens at once. Agent tokens (label `agents:*`) get `403 forbidden` |
| `POST /seller/inventory` | seller (the owner) | Upserts one item by `(seller, sku)`, so it needs no Idempotency-Key. Fields are described below. Returns the item in the `GET /seller/inventory` shape, including `floor_cents`. Agent tokens get `403 forbidden` |
| `POST /worker/sellers/:id/token` | worker | Body `{ hours? }` (1–72, default 24). **200** `{ token, seller_id, name, expires_at, agent_handle }`. `token` is 64-hex and returned once; only its sha256 hash is stored, with label `agents:seller-agent:<seller_id>`. It acts as the business's owner, like the seeded agent seller tokens. Errors: `404 seller_not_found`; `403 not_delegated` (delegation off or business disabled) |

**Business JSON** (`commerce_business_json`, never shown to buyers):
`{ seller_id, name, service_area, delivery_cents, delivery_days, delegate_negotiation, enabled, agent_handle, created_at, owner_email }`.
`owner_email` is the owner's account email, or `null` for demo actors.

**Validation:**
- `name`: 2–80 characters after trimming.
- `service_area`: `^[a-z_]{2,40}$`, default `san_francisco`.
- `delivery_cents`: 0–100000, default 0.
- `delivery_days`: 0–30, default 2.
- At most 5 businesses per person (`409 business_limit`).
- **Unique names:** names are unique case-insensitively among all businesses, enabled or not (`409 business_name_taken`). Older rows may already share names, so this is enforced inside register and rename under a per-name advisory lock, not by an index.

**Inventory item** (`POST /seller/inventory`):
`{ sku?, title, category, attributes?, list_cents, floor_cents, available }`.
- `sku`: if omitted, derived from the title (lowercase, dashes, at most 60 characters).
- `category`: `^[a-z_]{2,40}$`.
- `attributes`: an object.
- Prices: integers, with 0 < `floor_cents` ≤ `list_cents`.
- `available`: 0–100000.
- Other keys are rejected.

**Matching** uses the attributes. A request item `{category:"desk", max_width_in:48}` needs
`attributes.width_in <= 48`, and `{category:"chair", ergonomic:true}` needs `attributes.ergonomic === true`.

**Worker feed changes** (`GET /worker/events`):
- Every route now carries `route.seller_delegated` (the business's `delegate_negotiation`).
- New kind `order.confirmed`, a sale notice to the seller:
  - `route`: `{ to_role: "seller", seller_id, request_id, buyer_id, agent_handle?, delegated, seller_delegated }`.
  - `payload`: `{ order_id, reservation_id, request_id, seller_id, total_cents, currency, title }`. It has no
    buyer email, budget or floor.
- **Backing row:** each paid order writes the notice as its own outbox row (kind `order.confirmed.seller`,
  from a trigger on `commerce_orders`). The worker never touches the buyer receipt email's `order.confirmed`
  row: acking that row's ID is `404 event_not_found`.
- `POST /worker/events/:id/ack` on a sale notice returns `kind: "order.confirmed"`.

## Agent conversation and the web dashboard

Migration `20261018000700_conversation.sql` (doc/conversation-contract.md). Apply it **before** deploying this
backend: the conversation and dashboard routes need it. Acks keep working either way, because an ack with a
receipt falls back to the plain ack while the migration is missing.

**Delivery receipts:** `POST /api/v1/worker/events/:id/ack` (worker) takes an optional body
`{ "delivery": { transport, from_handle, to_handle, message_id, context_id, delivered_at } }`.
- **Validation:** values are strings of at most 200 characters, and `transport` is `inkbox` or `local`. Other
  keys are dropped. A non-object delivery or a bad value is `400 invalid_input`.
- **No receipt:** an empty body or `delivery: null` acks without one.
- **Retries:** the first receipt wins on a retried ack. The response is unchanged.

**Message** (one move; optional fields are absent, never null):
`{ kind: "opened"|"offer"|"counter"|"declined", by: "platform"|"seller"|"buyer", total_cents?, note?, reason?, version?, offer_id?, counter_id?, at, delivery? }`
- `delivery` is the receipt of the outbox event that announced the move: `session.opened`, `offer.created`,
  `counter.created` or `session.declined`. It is absent until the runner acks that event.
- `reason` appears on declines only.

**Session conversation:**
`{ session_id, request_id, seller_id, seller_name, status, turn, rounds, seller_agent, seller_handle, opened_at, current_offer: { offer_id, total_cents, expires_at } | null, messages: [Message] }`
- `seller_agent` is the business's `delegate_negotiation`.
- `current_offer` is set only while the session is open and its latest offer is current.

| Route | Access | Result |
|---|---|---|
| `GET /buy-requests/:id/conversation` (role or connector token) | `buyer` (own request) or `buyer_agent` (delegated request) | `{ request_id, title, status, delegate_negotiation, created_at, sessions: [Session conversation], best_offer: { session_id, seller_name, offer_id, total_cents } \| null, reservation: { reservation_id, offer_id, seller_id, status, total_cents } \| null }`. Sessions are sorted by seller name. |
| `GET /buy-requests/:id/conversation` (user session) | The owner (or a request-bound `request:read` delegation) | The same JSON, for the web live page |
| `GET /seller/sessions/:id/conversation` | `seller`: own session only (403 otherwise, 404 if missing) | One session conversation |

None of these carry floors, budgets, targets, line items, buyer IDs or buyer email.

**Web dashboard routes (user session only):** a delegation token gets `403 user_session_required`, and a role
or connector token gets 404.

| Route | Result |
|---|---|
| `GET /api/v1/buy-requests` | Newest first, up to 50. Each item keeps the original fields `{ id, requirements, status, currency, created_at }` and adds `{ request_id, title, structured_requirements, budget_cents, target_cents, delegate_negotiation, seller_count, open_sessions, best_offer: { offer_id, seller_name, total_cents } \| null, reservation: { reservation_id, offer_id, status, total_cents } \| null }`. The budget and target are the buyer's own. |
| `GET /api/v1/businesses` | The person's businesses: business JSON plus `{ inventory: [InventoryItem with floor_cents], open_sessions, orders, sales_cents }` |
| `GET /api/v1/businesses/:id/sessions` | Owner only. The business's negotiations, newest first: session conversation plus `request: { request_id, title, status, requirements, deadline, created_at }`. No budget, target or buyer. |
| `POST /api/v1/businesses/:id/inventory` | Owner only. Same body, validation and result as `POST /seller/inventory`. |
| `PATCH /api/v1/businesses/:id` | Owner only. Same keys, validation and result as `PATCH /seller/business`. |

**Errors on the business routes:**
- `invalid_id`: 400.
- `not_found`: 404.
- `forbidden` (not the owner): 403.
- `invalid_input`: 400.
- `business_name_taken`: 409.

## Hardening round 1 (migration 0800)

This section covers `migrations/20261018000800_hardening.sql` and `doc/hardening-contract.md`. Apply the migration
**before** deploying this backend; the backend falls back where it can (see "Rollout").

**Limits**
- **Round limit:** a session allows 8 seller offers. A counter after the 8th offer, or a 9th offer, closes the
  session, and the close is committed. It answers `409 round_limit`, and later moves get `409 session_closed`.
  The closed session's offers can no longer be reserved.
- **Request caps:** each signed-up person may have 5 requests in `negotiating` and create 20 per 24 hours.
  `POST /buy-requests` beyond that answers `429 too_many_requests`. A retried call with the same
  Idempotency-Key for a live request still replays it at the cap. Seeded demo actors (`is_demo`) are exempt.
- **Notes:** offer and counter notes are at most 500 characters (`400 invalid_input`), enforced in HTTP
  validation and in SQL.
- **Offers** expire after 24 hours (previously 2).

**Matching** (`POST /buy-requests`)
- **Own businesses:** a buyer's own businesses are never matched.
- **Regions:** compared after normalizing with `commerce_norm_region`: lowercase, other characters become `_`,
  and `sf`, `San Francisco, CA` and similar become `san_francisco`. Business service areas are stored
  normalized: `POST/PATCH` with `"San Francisco"` stores `san_francisco`, and digits are still invalid.
- **Deadline:** `requirements.deliver_by` becomes the request `deadline` when no `deadline` is sent.
  - A date (`YYYY-MM-DD`) means the end of that day anywhere on Earth: the next day, 12:00 UTC. A buyer in San
    Francisco asking for "tomorrow" in the evening still matches next-day sellers.
  - An ISO 8601 timestamp (`YYYY-MM-DDTHH:MM…`) is used as given.
  - Anything else, including words like `tomorrow`, is ignored, as before.
  - A seller matches only if `now() + delivery_days days <= deadline`. No deadline means no constraint.
- **No match** is not an error: the request is created with `sessions: []`.

**Idempotent retries**
- **Requests:** a reused request key returns the existing request only while it is `negotiating` or
  `awaiting_payment`. After the request is `confirmed` or `expired`, the same key (identical wording through
  MCP) creates a new request. Key uniqueness is now a partial unique index over live requests.
- **Reservations:** `POST /offers/:id/reservations` with a key whose hold is `expired` or `failed` starts a new
  hold. The dead hold's key is renamed `<key>#<reservation id>`. An expired request answers `409 request_expired`.

**Lifecycle**
- **Requests:** gain the status `expired` (deadline passed).
- **Payment:** `commerce_apply_payment` takes an optional `p_payment_intent` and stores it as
  `commerce_orders.stripe_payment_intent`. The webhook passes `session.payment_intent`. On payment it also:
  - closes every other open session of the request (`status closed`, `decline_reason 'another offer was accepted'`);
  - writes a `session.closed` event for each;
  - writes the buyer's order notice (outbox kind `order.confirmed.buyer`).

  The winning session is left as it was.
- **Stripe line items:**
  - one line per reserved item: title × quantity at the snapshot `unit_cents`;
  - then `Delivery` and `Tax` lines when above 0;
  - every line's description is `Sold by <seller> via Exchangent`, and names are capped at 250 characters;
  - the lines must add up to the reservation total, otherwise `reservation_pricing_mismatch`;
  - the Stripe idempotency key is unchanged.

**`POST /api/v1/worker/sweep`** (worker; the runner calls it every minute) returns
`{released_holds, expired_requests, closed_sessions}`. It releases stale holds and expires `negotiating`
requests past their deadline, closing their open sessions with reason `deadline passed` and a `session.closed`
event each. Rows that are busy are left for the next sweep. Before the migration it only releases holds and adds
`partial: true`.

**Worker feed versions:** `GET /api/v1/worker/events?limit=&v=`
- **`v=1`** (the default, what the running runner asks for) is unchanged.
- **`v=2`** adds two kinds:
  - **`session.closed`:** `route.to_role` is `seller`, with the usual route fields. Payload:
    `{session_id, request_id, reason}`. `reason` is `round limit`, `another offer was accepted` or
    `deadline passed`.
  - **`order.confirmed` with `route.to_role` `buyer`:** the buyer's order notice. Route
    `{to_role:'buyer', request_id, seller_id, buyer_id, agent_handle?, delegated, seller_delegated}`. Payload:
    `{order_id, reservation_id, request_id, seller_id, seller_name, total_cents, currency, title}`. The
    seller's sale notice stays `to_role 'seller'` (it has no `seller_name`).
- **Ack:** both notices ack as `kind: "order.confirmed"`, and `session.closed` acks as itself.
- **Errors:** any other `v` is `400 invalid_input`.

**New error codes**

| Code | Status | When |
|---|---|---|
| `round_limit` | 409 | The session reached its round limit and closed |
| `too_many_requests` | 429 | Request caps |
| `request_expired` | 409 | Reserving on an expired request |

**Rollout**
- **Order:** apply 0800, then deploy the backend, then switch the runner to `v=2` and the sweep.
- **Backend fallbacks without 0800:**
  - the webhook retries `commerce_apply_payment` without `p_payment_intent`;
  - `v=2` falls back to the v1 feed;
  - the sweep falls back to `commerce_release_stale_holds`.
- **Old runner after 0800:** the currently deployed runner (feed v1) never sees the new kinds, so it never takes a
  brain turn on `session.closed` or acks the buyer's notice. Until a v2 runner reads them, those rows wait in the
  outbox.

## Orders, cases, refunds and chargebacks (migration 0900)

`src/resolution.ts`, `src/disputes.ts`; design in `doc/resolution-design.md`, contract in
`doc/resolution-contract.md`. The SQL functions decide everything (who may act, which automatic rule
applies, what is still refundable); the backend executes the refunds they return through Stripe with
Idempotency-Key `exchangent-refund-<refund_id>` and records the result. All responses are `{data}`.

**Order JSON** (`GET /orders/:id`, lists): `{order_id, request_id, title, seller_id, seller_name, status
(confirmed|shipped|delivered|closed|cancelled|refunded), total_cents, refunded_cents, refundable_cents,
currency, created_at, shipped_at, delivered_at, carrier, tracking, delivery_evidence:{source:
carrier|simulated|buyer_confirmed, at}|null, dispute_window_ends_at, deliver_by, delivery_cents, tax_cents,
items:[{inventory_id,title,quantity,unit_cents,category}], cases:[{case_id,type,status,opened_by,turn,version,
updated_at}], refunds:[{refund_id,amount_cents,status,reason,case_id,created_at}], disputes:[{dispute_id,status,
reason,amount_cents,decision,submitted_at}]}`. Seller views add `shipping_name:"Buyer"` (no buyer identity).

**Case JSON**: `{case_id, order_id, request_id, seller_id, seller_name, title, type, opened_by, status
(open|resolved|escalated|closed), turn (buyer|seller|null), version, rounds, items, description, evidence:[{kind,
ref, by, at}], remedy (the proposal on the table)|null, remedy_by, requested_remedy, resolution:{...remedy,
amount_cents, how: auto|policy|agreed, by, at}|null, substitute_check|null, total_cents, refunded_cents,
refundable_cents, order:{status,total_cents,refunded_cents,refundable_cents,shipped_at,delivered_at,carrier,tracking,
delivery_evidence,deliver_by,items}, moves:[{by, action: open|offer|accept|decline|auto|escalate|evidence|
return_received, remedy?, note?, version, at}], refunds:[...], created_at, updated_at}`. Seller views also carry
`policy`; buyer and buyer-agent views never do (its auto-approve limit works like a floor).

**Remedy** (request bodies): `{kind: refund_full|refund_partial|refund_items|replace|return_for_refund|
keep_with_discount|sla_credit|cancel, amount_cents?, items?:[{inventory_id, quantity?}], return_shipping_paid_by?}`.
The backend computes item amounts from the paid snapshots and caps every amount at `refundable_cents`.
`cancel` only before shipping; `return_for_refund` refunds when the seller confirms the return; a cheaper
substitute refunds the difference.

| Route | Who | Body / notes |
|---|---|---|
| `GET /orders` | buyer (role, connector or user session) | The buyer's orders, newest first (50) |
| `GET /orders/:id` | buyer, buyer agent (delegated), seller | Order JSON |
| `POST /orders/:id/received` | buyer only | Delivered, evidence `buyer_confirmed` |
| `POST /orders/:id/cases` | buyer only | `{type, items?, description?, evidence?, requested_remedy?}`, Idempotency-Key. Applies the automatic rules first (below). |
| `GET /cases/:id` | buyer, buyer agent (delegated), seller | Case JSON |
| `POST /cases/:id/respond` | the side whose turn it is | `{expected_version, action: accept\|counter\|decline, remedy?, note?}`. Six counters, then `escalated`; decline escalates. |
| `POST /cases/:id/evidence` | either side, open or escalated case | `{kind, ref}` or `{evidence:[...]}` (max 20 per case) |
| `POST /refunds/:id/retry` | buyer or seller of the order | Re-executes a failed refund (same Stripe idempotency key) |
| `GET /seller/orders`, `GET /seller/cases` | seller (agents too) | Lists |
| `POST /seller/orders/:id/ship` | owner only | `{carrier, tracking}`; confirmed → shipped |
| `POST /seller/orders/:id/simulate-delivery` | owner only, Stripe test mode | shipped → delivered, evidence `simulated`; returns `simulated:true` |
| `POST /seller/orders/:id/issue` | owner only | `{kind: out_of_stock\|address_problem, items?, substitute?:{replaces, inventory_id, unit_cents?}, note?}` |
| `POST /cases/:id/return-received` | owner only | Restocks and refunds a `return_for_refund` |
| `GET` / `PUT /seller/policy` | seller / owner only | Policy below |
| `GET /worker/buyer-requests?email=` | worker | Email-your-agent lookup (below) |
| `GET /worker/sellers/:id/owner` | worker | `{seller_id, name, owner_email\|null}` for owner notices |
| `POST /worker/resolution-sweep` | worker | Closes delivered orders past the dispute window: `{orders_closed}` |

Owner only = a seller token whose label is not `agents:*` (agent tokens get 403): physical-world facts and the
policy come from the owner. User-session twins for the web dashboard: `GET /api/v1/orders`, `GET|POST
/api/v1/orders/:id[/received|/cases]`, `GET|POST /api/v1/cases/:id[/respond|/evidence]`, and for an owner
`GET /api/v1/businesses/:id/orders|cases`, `POST /api/v1/businesses/:id/orders/:oid/ship|simulate-delivery`,
`POST /api/v1/businesses/:id/cases/:cid/respond|evidence|return-received`, `GET|PUT /api/v1/businesses/:id/policy`.

**Automatic rules** (`commerce_open_case`): `not_received` with no delivery recorded after the deadline (request
deadline, else `deliver_by`, else shipping/order time) plus `auto_refund_not_received_after_days` → refund the
items (all if none given); `late` delivered after the deadline → `sla_credit` of the delivery fee;
`duplicate_charge` → the closest other paid order of the same buyer, seller and total within 10 minutes is
cancelled, restocked and refunded; `changed_mind` → `cancel` before shipping, declined after the return window,
else `return_for_refund` minus `restocking_fee_pct`; a `requested_remedy` of `refund_partial` or
`keep_with_discount` at or below `max_auto_partial_refund_pct` of the total → accepted under policy.

**Policy** (`GET|PUT /seller/policy`, defaults): `auto_refund_not_received_after_days 3,
max_auto_partial_refund_pct 15, return_window_days 14, restocking_fee_pct 0,
seller_pays_return_shipping_when_at_fault true, price_protection_days 0, fight_chargebacks_above_cents 5000`.
Unknown keys, non-integers and out-of-range values are `invalid_input`.

**Chargebacks** (`POST /webhooks/stripe`): `charge.dispute.created` finds the order by PaymentIntent (orders paid
before 0800 are found through their Checkout Session), then decides once: **fight** when the order is already
refunded for the amount, or when it was delivered or the reason is `fraudulent`/`unrecognized` and the amount is
at least `fight_chargebacks_above_cents`; otherwise **accept** (`disputes.close`). Fighting submits text
evidence only: `product_description` (items and attributes), `uncategorized_text` (the buyer's own payment
approval with timestamps, delivery, refunds, cases), `access_activity_log` (the negotiation transcript),
`refund_policy_disclosure`, shipping fields and `refund_refusal_explanation`. `charge.dispute.updated|closed`
update the status; `charge.refunded` settles refunds Stripe accepted as pending.

**Errors**: `order_not_found`/`case_not_found`/`refund_not_found` 404, `item_not_in_order` 400,
`case_already_open`, `order_closed`, `case_closed`, `stale_case`, `not_your_turn`, `nothing_to_accept`,
`already_shipped`, `order_not_shippable`, `order_not_shipped`, `no_return_expected`, `price_increase_not_allowed`,
`below_floor`, `out_of_stock` 409, `test_mode_only` 403, `refund_failed` 502 (the case is already resolved; retry
the refund).

**Worker feed**: resolution events are separate outbox rows (`res:<event>:<to_role>`) shown only to a runner that
asks: `GET /worker/events?include=resolution` merges them, in creation order, with the negotiation feed. Kinds
and `route.to_role`: `order.shipped`, `order.delivered`, `refund.succeeded` → buyer; `case.opened` → the side to
answer; `case.offer` → the other side; `case.resolved`, `case.escalated` → one row each for buyer and seller;
`dispute.created`, `dispute.decided` → seller. `route` adds `order_id` and `case_id` to the usual fields
(`request_id, seller_id, buyer_id, agent_handle, delegated, seller_delegated`). Payloads: cases
`{case_id, order_id, request_id, seller_id, type, status, turn, version, opened_by, remedy_kind, amount_cents, title}`;
orders `{order_id, request_id, seller_id, seller_name, status, total_cents, carrier, tracking, title}`; refunds
`{refund_id, order_id, case_id, amount_cents, reason, seller_id, title}`; disputes add `{dispute_id, reason,
amount_cents, decision}` to the order payload. Ack them with the usual `POST /worker/events/:id/ack` (receipts
accepted).

**Email your agent** (`GET /worker/buyer-requests?email=`): the delegated requests (negotiating, awaiting payment,
or confirmed in the last 14 days) of the account with exactly that email, newest first, max 10:
`[{request_id, title, status, created_at, sessions_open, best_offer:{seller_name,total_cents}|null,
order:{order_id,status,seller_name,total_cents}|null, watch_path:"/watch/<id>"}]`. No budgets, targets or other
people's data; reply only to that same registered address.

**Receipts**: `GET /reservations/:id` keeps `order.status: "confirmed"` while a paid order is shipped, delivered
or closed (clients checking for `confirmed` keep working) and adds `order.lifecycle_status`.

## MCP and dashboard integration

- The Manufact MCP OAuth handshake belongs to the teammate. An arbitrary ChatGPT,
  Claude or provider OAuth token cannot be forwarded as an InsForge user token.
  Account linking must establish a verified Exchangent identity first.
- A buyer assistant creates a request through the authenticated user flow. The
  human explicitly delegates task scopes to a worker, which stores the credential
  privately and uses it after the originating chat closes.
- `get_status` can read the request and reservation endpoints; `get_offers` maps
  to the offer endpoint. Seller status maps to seller activity. Dashboard reads
  use the same routes with the signed-in user's access token.
- Never accept a `buyer_id` or `seller_id` from a model as proof of ownership.
- Activity currently means persisted offers and orders, not live reasoning,
  worker heartbeats or Inkbox transcripts. Those need explicit worker events and
  separate authorized projections.
- Ceilings, price floors, credential hashes and other owners' data are omitted
  from these projections. Requirements entered by the buyer are their own text;
  avoid embedding private limits into seller-facing messages.

## Verification and remaining work

14 local tests pass, including scope restrictions, upstream identity mapping,
expiry/revocation, input validation, redaction and payment protections.
Four real-service authentication tests pass: forged tokens are rejected, request
delegations can read only their task, seller delegations are isolated, and
anonymous clients cannot mint actors or read credentials. The tests revoke their
administratively bootstrapped credentials afterward.

Positive human login, frontend OAuth/email verification and consent UI have not
been tested end to end. The project's verification requirement was left enabled.
Public hosting, rate limits, sign-in/session handling in Next.js, commission
pricing, seller onboarding and worker matching remain future work.

### Reviewed payment amount

`POST /offers/:id/reservations` accepts an optional JSON body
`{"expected_total_cents":36000}`. This must be a positive PostgreSQL integer in
cents. If it differs from the reserved total, `price_changed` is returned and the
entire hold rolls back. Refresh the offer and obtain human approval again.
Existing callers may omit the body. No buyer commission is collected in the demo.

`GET /reservations/:id` also returns `seller` (`id`, `name`), reserved `items`
(`title`, `quantity`, `unit_cents`), `subtotal_cents`, `delivery_cents`, `tax_cents`
and `expires_at`. These fields are owner-only. A checkout redirect is navigation;
only the verified Stripe webhook creates a confirmed order. `payment_pending`
means wait for verification rather than creating another payment.
