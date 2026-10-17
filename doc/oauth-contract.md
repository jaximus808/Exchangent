# Connector OAuth contract

How a person connects Exchangent to ChatGPT or Claude. They never need a Manufact
account.

1. The person adds the Exchangent connector (the Manufact MCP server URL) in ChatGPT or Claude.
2. The MCP server's OAuth proxy (mcp-use `oauthProxy`, generic `upstream()`) sends their browser to
   **Exchangent's authorize page** in `web/`.
3. They sign in or create an Exchangent account with InsForge email one-time-code sign-in, the
   existing `web/app/actions.ts` flow.
4. **Consent screen:** they choose what to authorize, either their **buyer account** or **one business
   they own**, then approve or deny.
5. The backend issues an authorization code. The proxy exchanges it at the backend token endpoint for
   a **connector access token** (`exc_...`) bound to that actor and role.
6. The MCP server forwards `Authorization: Bearer exc_...` on every tool call. The backend resolves it
   to the same buyer or seller principal the negotiation routes already enforce.

## Roles and endpoints

| Piece | Lives in | URL |
|---|---|---|
| Authorize page (sign-in and consent) | `web/` Next.js, a separate Vercel project with root `web` | `https://<web-app>/oauth/authorize` |
| Consent API (issues the code) | `backend/` | `POST https://exchangent.vercel.app/api/v1/oauth/authorize` |
| Targets API (what the user can authorize) | `backend/` | `GET https://exchangent.vercel.app/api/v1/oauth/targets` |
| Token endpoint (RFC 6749) | `backend/` | `POST https://exchangent.vercel.app/api/v1/oauth/token` |
| OAuth client (the MCP server) | Row in `commerce_oauth_clients` | Created by `npm run oauth:client --prefix backend` |

## Authorize page: `GET /oauth/authorize` (web)

Query: `response_type=code`, `client_id`, `redirect_uri`, `state`, `scope` (space-separated; may be
empty), and optionally `code_challenge` with `code_challenge_method=S256`. Other parameters are ignored.

- If the request is invalid (missing `client_id` or `redirect_uri`, or `response_type` is not `code`),
  show an error page. Never redirect to an unvalidated `redirect_uri`.
- If the person isn't signed in, show the email one-time-code sign-in. A new email creates an
  Exchangent account.
- Once they're signed in, call `GET /api/v1/oauth/targets?client_id=...&redirect_uri=...` with their
  InsForge access token. The backend validates the client and redirect URI and returns
  `{ data: { client: { client_id, name }, account: { actor_id, email }, businesses: [{ seller_id, name }] } }`.
  A `400 invalid_client` or `invalid_redirect_uri` shows an error page.
- Consent shows the client name ("Claude", for example), the signed-in email, and radio options:
  "Buyer account (<email>)" plus one per business ("<business name>, seller"). It also lists what
  each choice allows:
  - Buyer: create buy orders, see offers, counter, reserve, get checkout links. It never pays.
  - Seller: see requests, make offers within your price floors, decline.

  Then Approve and Deny buttons.
- **Approve** (server action): `POST /api/v1/oauth/authorize` with the InsForge access token and body
  `{ client_id, redirect_uri, scope, state, code_challenge?, code_challenge_method?, target: { kind: "buyer" } | { kind: "seller", seller_id } }`.
  It returns `{ data: { redirect_to } }`, the full `redirect_uri?code=...&state=...` URL built by the
  backend, and the page redirects there.
- **Deny:** redirect to `redirect_uri?error=access_denied&state=...`, but only after the targets call
  has validated that `redirect_uri`.

## Backend endpoints

`GET /api/v1/oauth/targets` and `POST /api/v1/oauth/authorize` need an InsForge **user session**
(the existing `Auth.authenticate`, which gives `kind: 'user'`). Delegations, connector tokens and demo
role tokens get `403 user_session_required`. The authorize call must:
- validate the client, an exact-match redirect URI, `kind`, and ownership (`commerce_sellers.owner_id = actor`);
- store the code as a SHA-256 hash, valid for 5 minutes and single-use, together with the client,
  redirect URI, actor, kind, seller_id, scope and PKCE challenge. The backend **requires** an S256
  challenge (see "Backend implementation notes");
- return `redirect_to`.

`POST /api/v1/oauth/token` follows the OAuth standard, not the `{data}` envelope:
- **Body:** `application/x-www-form-urlencoded` or JSON. **Client authentication:** HTTP Basic
  (`client_id:client_secret`), or `client_id` and `client_secret` in the body.
- **`grant_type=authorization_code`:** takes `code`, `redirect_uri` and `code_verifier`. The verifier
  is required when the code was issued with a challenge. The code must be unused, unexpired, and issued
  to this client and redirect URI.
- **`grant_type=refresh_token`:** takes `refresh_token`. It rotates both tokens, and reusing an old
  refresh token revokes the whole grant.
- **Success:** `200 {"access_token":"exc_...","token_type":"Bearer","expires_in":3600,"refresh_token":"exr_...","scope":"buyer"|"seller"}`
  with `Cache-Control: no-store`.
- **Errors:** `400 {"error":"invalid_grant"|"invalid_request"|"unsupported_grant_type", "error_description":"..."}`,
  or `401 {"error":"invalid_client"}`.
- **Token lifetimes:** access tokens last 1 hour, refresh tokens 30 days. Only SHA-256 hashes are
  stored. A grant can be revoked.

### What the MCP proxy actually sends

These come from the mcp-use 2.10.1 and oauth4webapi source and are asserted in `mcp/test/oauth.test.ts`.

- **Redirect URI:** always `<MCP_URL>/mcp/oauth/callback`. Register exactly this value for the client.
- **Authorize request:** `response_type=code`, `client_id`, `redirect_uri`, a random `state`,
  `scope=buyer seller`, `code_challenge` and `code_challenge_method=S256`. **PKCE is always sent.**
- **Redirect back:** contains only `code` and `state`. Don't add `iss`. If it is present, it must equal
  the web app's origin. Don't add `id_token` or `token`.
- **Token request:** uses **client_secret_post** only, with `client_id` and `client_secret` in the
  form body and never HTTP Basic. The content type is
  `application/x-www-form-urlencoded;charset=UTF-8`, so the backend must accept the `;charset` suffix.
- **Token response:** must be HTTP 200 JSON with `access_token` and `token_type: "Bearer"`. The proxy
  refreshes when the token is within 60 seconds of expiry, and keeps the old refresh token if the
  response doesn't include one.
- **Profile check:** right after the code exchange, the proxy calls `GET /api/v1/me` with the new
  token. A non-2xx response or a missing `actor_id` fails the sign-in.

## Principal resolution

A Bearer `exc_...` token resolves, while it is unexpired and unrevoked, to:
- buyer grant: `{ scope: 'buyer', actor_id }`
- seller grant: `{ scope: 'seller', actor_id, seller_id }`

These are the same principal shapes the negotiation routes use today (`backend/src/negotiation`), so
every buyer and seller route and every MCP tool works unchanged. `GET /api/v1/me` returns
`{ kind: 'connector', scope, actor_id, seller_id, client_id }` for these tokens. Seeded 64-hex role
tokens keep working for the autonomous agent runner.

## Demo setup

- `npm run oauth:client --prefix backend -- --name "Exchangent MCP" --redirect-uri <proxy callback URL>`
  creates or updates the MCP server's client and prints the `client_id` and `client_secret` once.
  Store those as Manufact environment variables, never in git.
- `npm run assign:seller --prefix backend -- --email <person> --seller "Bay Desk Co"` makes a signed-up
  person the owner of a demo business, so it appears on their consent screen.

## Backend implementation notes

These are where the backend (`backend/src/oauth.ts`, `migrations/20261018000200_connector-oauth.sql`)
is stricter than or more specific than the sections above.

- **PKCE is mandatory.** `POST /api/v1/oauth/authorize` without a `code_challenge`, or with a
  method other than `S256`, returns `400 invalid_request`, and the token exchange always needs
  `code_verifier`. The MCP proxy always sends PKCE, so this changes nothing for it. A connection
  link without a challenge now fails at Approve with the web page's "incomplete request" message.
- **Seller targets:** a business the person doesn't own, or one that is disabled or missing,
  returns `403 forbidden`, never `404`.
- **Scope:** if the requested `scope` names `buyer` or `seller` but not the chosen kind, authorize
  returns `400 invalid_scope`. An empty scope or the proxy's `buyer seller` accepts either kind.
- **Replay:** presenting a used authorization code revokes the tokens it issued
  (RFC 6749 section 4.1.2). Presenting a rotated refresh token revokes the whole grant. A failed
  exchange (wrong verifier or wrong `redirect_uri`) does not use up the code.
- **Client authentication:** sending Basic and body credentials that disagree returns
  `400 invalid_request`. A revoked client returns `401 invalid_client`.
- **Seller grants** stop working, for both the access token and refresh, as soon as the actor no
  longer owns that business.
