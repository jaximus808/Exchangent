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
