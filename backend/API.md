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
| `POST /webhooks/stripe` | Raw body verified with Stripe signature; no user Bearer token |

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
