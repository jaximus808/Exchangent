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
