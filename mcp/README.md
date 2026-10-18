# Exchangent MCP server

MCP server built with [mcp-use](https://github.com/mcp-use/mcp-use) (v2.10.1). It exposes the
buyer and seller negotiation tools from [`doc/negotiation-contract.md`](../doc/negotiation-contract.md)
and forwards every call to the backend HTTP API. It is a thin adapter: the backend enforces every
rule (role, turn, version, budget, floor, stock) and is the source of truth.

- Transport: Streamable HTTP at `http://127.0.0.1:3100/mcp` (`PORT` overrides 3100).
- Backend: `EXCHANGENT_API_URL` (default `http://127.0.0.1:8787/api/v1`).
- Auth: two modes, picked by `EXCHANGENT_AUTH` (see [Authentication modes](#authentication-modes)):
  - `bearer` (default): the caller's `Authorization: Bearer <token>` header on the MCP HTTP request
    is forwarded to the backend. The token decides whether you are a buyer or a seller.
    `EXCHANGENT_TOKEN` is a dev-only fallback, used only when the MCP request has no
    `Authorization` header. The agent runner and the existing Manufact server (`warm-pulse`) use this.
  - `oauth`: people connect from Claude or ChatGPT and sign in to Exchangent in the browser. The
    server forwards their Exchangent connector token (`exc_…`). Callers can't send their own
    bearer token, and `EXCHANGENT_TOKEN` is ignored.

## Run locally

```sh
cd mcp
npm install
cp .env.example .env          # optional; edit EXCHANGENT_API_URL / PORT
npm run dev                   # mcp-use dev: hot reload + Inspector at http://127.0.0.1:3100/mcp/inspector
# or production mode:
npm run build && npm start    # serves .mcp-use/build on PORT (default 3100)
npm run typecheck
npm test                      # bearer + oauth end-to-end tests against fakes (no real backend needed)
```

Without `EXCHANGENT_AUTH`, the server runs in bearer mode. To try oauth mode locally, see
[Run oauth mode locally](#run-oauth-mode-locally).

The mcp-use CLI loads the project `.env`. For `npm run dev`, set the port with the shell's
`PORT`, because the script passes `--port ${PORT:-3100}`.
The Inspector sends no `Authorization` header, so set `EXCHANGENT_TOKEN` to try tools from it.

## Tools

All money inputs are integer US cents (`*_cents`). Outputs return cents, plus a `*_display`
string such as `"$520.00"` for each `*_cents` field the backend returned. Every result's
`structuredContent` (also sent as JSON text) has this shape:

```json
{ "status": "ok", "...backend data...": "...", "next": "One sentence telling the agent what to do next." }
{ "status": "error", "error": { "code": "stale_offer", "message": "...", "next_action": "...", "http_status": 409 }, "next": "..." }
```

Error results set `isError: true`. They're tool results, not thrown exceptions. If the backend
data has its own `status` field, it's renamed so it doesn't clash with the envelope:
`request_status`, `session_status` or `reservation_status`.

| Tool | Role | Backend call |
|---|---|---|
| `create_buy_order` | buyer | `POST /buy-requests` |
| `get_buy_order` | buyer | `GET /buy-requests/:id` |
| `get_conversation` | buyer | `GET /buy-requests/:id/conversation`: how the agents negotiated, one chat thread per seller with Inkbox A2A hops (view `conversation`, refreshes every 3 s while open). Adds `watch_url`. |
| `list_offers` | buyer | `GET /buy-requests/:id/offers` |
| `counter_offer` | buyer | `POST /sessions/:id/counters` |
| `decline_seller` | buyer | `POST /sessions/:id/decline` |
| `reserve_offer` | buyer | `POST /offers/:id/reservations` |
| `get_checkout_link` | buyer | `POST /reservations/:id/checkout` |
| `get_reservation_status` | buyer | `GET /reservations/:id` |
| `list_my_requests` | seller | `GET /seller/sessions?status=open` |
| `get_negotiation` | seller (works for either role) | `GET /sessions/:id` |
| `get_inventory` | seller | `GET /seller/inventory` |
| `make_offer` | seller | `POST /sessions/:id/offers` |
| `decline_request` | seller | `POST /sessions/:id/decline` |
| `register_business` | buyer (any signed-in person) | `POST /businesses`. Then reconnect and choose the new business |
| `get_business` | seller | `GET /seller/business` |
| `update_business` | seller (owner only) | `PATCH /seller/business`. `agent_negotiates` maps to `delegate_negotiation` |
| `upsert_inventory_item` | seller (owner only) | `POST /seller/inventory`. Upserts by `sku` |
| `whoami` | either | bearer mode: `GET /me`. oauth mode: the signed-in grant, with no backend call |
| `list_my_orders` | buyer | `GET /orders` |
| `get_order` | buyer | `GET /orders/:id`: shipping timeline, problem cases and refunds (view `order-detail`) |
| `confirm_received` | buyer | `POST /orders/:id/received` |
| `open_case` | buyer | `POST /orders/:id/cases`. Verifiable facts settle it automatically, otherwise the seller responds within their policy |
| `add_evidence` | either | `POST /cases/:id/evidence` |
| `respond_to_case` | either | `POST /cases/:id/respond` (`accept`, `counter` with a remedy, or `decline`; pass the case `version`) |
| `get_case` | either | `GET /cases/:id` (view `case-detail`) |
| `list_orders` | seller | `GET /seller/orders` |
| `mark_shipped` | seller | `POST /seller/orders/:id/ship` |
| `simulate_delivery` | seller, **test mode only** | `POST /seller/orders/:id/simulate-delivery`: a labelled simulated carrier scan, since real tracking isn't connected |
| `report_fulfilment_issue` | seller | `POST /seller/orders/:id/issue` (`out_of_stock` with an optional substitute, or `address_problem`) |
| `list_cases` | seller | `GET /seller/cases` |
| `confirm_return` | seller | `POST /cases/:id/return-received` (issues the refund for `return_for_refund`) |
| `get_resolution_policy` | seller | `GET /seller/policy` |
| `set_resolution_policy` | seller (owner only) | `PUT /seller/policy` |

The order and case tools need a backend with the resolution routes (`migrations/20261018000900_resolution.sql`). Against
an older backend they return `not_found` with a `next` that says the feature isn't enabled yet, rather than blaming the
ID.

`whoami` returns `auth_mode` (`bearer` or `oauth`). In oauth mode it also returns `actor_id`,
`kind`, `scope` (`buyer` or `seller`), `seller_id`, `client_id`, `acting_as` and
`authorization_expires_at` from the sign-in. It never returns a token. Use it in demos to show
which account a connection acts for.

**Idempotency.** Every mutation sends an `Idempotency-Key`. Pass `idempotency_key` to set it
yourself. Otherwise it's derived from the tool name, target ID, `expected_version` and a SHA-256
hash of the canonical request body:
`mcp:<tool>:<id|new>[:v<expected_version>]:<hash24>`.
When a model retries an identical call, the key is the same, so the backend replays the first
result. To repeat an action on purpose, such as reserving the same offer again after a
reservation expires, pass a new `idempotency_key`.

## Connect a client

### Claude Code

```sh
claude mcp add --transport http exchangent http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer <token>"
```

Use a buyer token for a buyer agent and a seller token for a seller agent. The seed script writes
these tokens to `backend/.demo-principals.json`. Tools appear as `mcp__exchangent__<tool>`. For
headless agents (`claude -p`), pass an `--mcp-config` file:

```json
{ "mcpServers": { "exchangent": { "type": "http", "url": "http://127.0.0.1:3100/mcp",
  "headers": { "Authorization": "Bearer <token>" } } } }
```

### Claude Desktop

Desktop's `claude_desktop_config.json` launches stdio servers. Bridge to the HTTP endpoint with
`mcp-remote`, and keep the space-containing header value in an env var:

```json
{
  "mcpServers": {
    "exchangent": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:3100/mcp", "--header", "Authorization:${EXCHANGENT_AUTH}"],
      "env": { "EXCHANGENT_AUTH": "Bearer <buyer-token>" }
    }
  }
}
```

### Claude Code, Claude.ai or ChatGPT with sign-in (oauth mode)

Point the client at the oauth-mode server (the second Manufact server, see
[Deploy the oauth server](#deploy-the-oauth-server-a-second-manufact-server)). Don't send a header:

```sh
claude mcp add --transport http exchangent https://<oauth-server-host>/mcp
```

Then run `/mcp` in Claude Code, select `exchangent` and authenticate. The browser opens the
proxy's consent page, then Exchangent's sign-in page (`web/`). There the person signs in or creates
an account and picks their buyer account or one of their businesses. Then the browser returns to
Claude Code. To switch accounts, use `/mcp` again to re-authenticate. In Claude.ai or ChatGPT,
add the same `https://<oauth-server-host>/mcp` URL as a custom connector. The client discovers
OAuth by itself, and nobody needs a Manufact account.

Don't set `EXCHANGENT_TOKEN` on a public deployment. In bearer mode, every header-less caller
would act as that principal. In oauth mode it's ignored.

## Authentication modes

### `bearer` (default)

The MCP request's `Authorization: Bearer <token>` header is forwarded to the backend as-is. The
token can be a seeded 64-hex role token or any token the backend accepts. If there's no header,
`EXCHANGENT_TOKEN` is used (dev only). Nothing else changes from earlier versions.

### `oauth`

`index.ts` passes `oauth: oauthProxy(...)` from `mcp-use/oauth` (`src/auth.ts`). The MCP server then
becomes an OAuth authorization server for MCP clients, in front of Exchangent's own OAuth server
([`doc/oauth-contract.md`](../doc/oauth-contract.md)):

1. An MCP request without a token gets `401` with
   `WWW-Authenticate: Bearer error="invalid_token", ..., resource_metadata="<MCP_URL>/.well-known/oauth-protected-resource/mcp"`.
   Every request needs a token, including `initialize`, `tools/list` and view reads (no `mixedAuth`).
2. The client reads `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
   These list `<MCP_URL>/mcp/oauth/{authorize,token,register,revoke}`. The client then registers
   (DCR) or presents a client ID metadata document.
3. The browser opens `<MCP_URL>/mcp/oauth/authorize`. The proxy shows its own consent page, then
   redirects to `EXCHANGENT_OAUTH_AUTHORIZE_URL` (web/).
4. Exchangent redirects back to `<MCP_URL>/mcp/oauth/callback` with a code. The proxy exchanges it at
   `EXCHANGENT_OAUTH_TOKEN_URL`, then calls `GET {EXCHANGENT_API_URL}/me` with the new `exc_…`
   token to learn the actor, scope and seller.
5. The client gets the proxy's own `mcp_at_…` and `mcp_rt_…` tokens. Before each request, the
   proxy refreshes the `exc_…` token if it expires within 60 seconds, using the stored `exr_…`
   refresh token.
6. Each tool forwards `Authorization: Bearer <exc_…>` (`upstreamToken(ctx.auth)`) to the backend.
   The `mcp_at_…` token never reaches the backend, and no token appears in tool output or logs.
   If the backend returns `401`, the tool returns an `unauthorized` error result. Its `next` tells
   the human to reconnect and sign in again. If it returns `403`, `next` points to `whoami` and to
   reconnecting with the other account.

`ctx.auth.user` comes from `/me` (`{ kind: "connector", scope, actor_id, seller_id, client_id }`).
The proxy subject, which keys the stored `exc_…` token per person, is
`<actor_id>:<scope>[:<seller_id>]`. A person's buyer grant and each business grant are stored
separately. If the same person authorizes the same account from two clients, both grants share
the newest `exc_…` token.

### Environment variables

| Variable | Mode | Required | Meaning |
|---|---|---|---|
| `EXCHANGENT_AUTH` | both | no | `bearer` (default) or `oauth`. Any other value fails at startup. |
| `EXCHANGENT_WEB_URL` | both | no | Web app base for `watch_url` (`<base>/watch/<request_id>`) on `create_buy_order`, `get_buy_order` and `get_conversation`. Default `https://web-five-jet-34.vercel.app`. |
| `EXCHANGENT_API_URL` | both | yes in prod | Backend base, for example `https://exchangent.vercel.app/api/v1` (default `http://127.0.0.1:8787/api/v1`). oauth mode also calls `GET /me` here. |
| `EXCHANGENT_TOKEN` | bearer | no | Dev-only fallback when the MCP request has no `Authorization` header. Ignored in oauth mode. |
| `PORT`, `HOST` | both | no | Listen port (3100) and host. Set `HOST=0.0.0.0` on Manufact if the runtime doesn't. |
| `EXCHANGENT_OAUTH_AUTHORIZE_URL` | oauth | **yes** | The web app's authorize page, `https://<web-app>/oauth/authorize`. No default, so startup fails if it's missing. |
| `EXCHANGENT_OAUTH_TOKEN_URL` | oauth | no | Default `https://exchangent.vercel.app/api/v1/oauth/token`. |
| `EXCHANGENT_OAUTH_CLIENT_ID` / `EXCHANGENT_OAUTH_CLIENT_SECRET` | oauth | **yes** | This server's confidential client, from `npm run oauth:client --prefix backend`. Secret: never put it in git. |
| `MCP_URL` | oauth | **yes** when public | Public origin with **no path**, for example `https://<server-host>`. The OAuth resource becomes `<MCP_URL>/mcp`, and the upstream callback becomes `<MCP_URL>/mcp/oauth/callback`. Without it, only a localhost `listen()` works. |
| `MCP_USE_OAUTH_SECRET` | oauth | **yes** when public | At least 32 characters (`openssl rand -base64 32`). Encrypts everything in storage and signs cookies. Use the same value on every instance. Changing it signs everyone out; to rotate without that, see the mcp-use docs. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | oauth | **yes** when public | Shared store for clients, sign-ins, grants and tokens (`upstashStorage`). Without them, `memoryStorage()` is used, and only when `MCP_URL` is unset or localhost. A public `MCP_URL` without Upstash fails at startup. |

### Upstream OAuth contract (what the proxy sends to Exchangent)

The proxy behaves as follows. This is checked against the mcp-use 2.10.1 source
(`dist/oauth/index.js`, `dist/chunk-3XIIMBWV.js`, which uses `oauth4webapi` 3.8.8), and
`test/oauth.test.ts` asserts the key parts.

- **Redirect URI to allowlist:** `<MCP_URL>/mcp/oauth/callback`, exactly. It's built from the
  resource origin, which is `MCP_URL`. One URL serves every MCP client. Register it with:
  `npm run oauth:client --prefix backend -- --name "Exchangent MCP" --redirect-uri https://<server-host>/mcp/oauth/callback`.
  For local runs it's `http://localhost:<port>/mcp/oauth/callback`.
- **Authorize request:** a browser `GET EXCHANGENT_OAUTH_AUTHORIZE_URL` with these query params:
  - `response_type=code`
  - `client_id`
  - `redirect_uri=<MCP_URL>/mcp/oauth/callback`
  - `state`: random, 32 bytes base64url
  - `scope=buyer seller`
  - `code_challenge`: S256 of a fresh verifier
  - `code_challenge_method=S256`

  **PKCE is always sent** (`pkce: true`). No other params are sent.
- **Callback:** redirect to `redirect_uri?code=...&state=...`, or `?error=access_denied&state=...`.
  If you add `iss`, it must equal the **origin of the authorize URL** (the web app). That origin
  is the default issuer, and the proxy rejects any other value. Don't return `id_token` or `token`
  in the redirect. Codes are exchanged within seconds.
- **Token request (code):**
  - `POST EXCHANGENT_OAUTH_TOKEN_URL`
  - Headers: `content-type: application/x-www-form-urlencoded;charset=UTF-8` (note the charset
    parameter) and `accept: application/json`.
  - Body: `grant_type=authorization_code`, `code`, `redirect_uri` (same as above), `code_verifier`,
    `client_id`, `client_secret`.

  **Client authentication is `client_secret_post`:** the id and secret go in the form body, never
  HTTP Basic.
- **Token request (refresh):** same endpoint and headers. Body: `grant_type=refresh_token`,
  `refresh_token`, `client_id`, `client_secret`. Each refresh stores the returned `refresh_token`.
  If the response has none, the old one is kept. Refreshes run under a storage lock, so a rotated
  refresh token is never reused by a second instance.
- **Token response:**
  - **Status:** must be **HTTP 200** with a JSON object.
  - **Required:** `access_token` (string) and `token_type` (`Bearer` or `bearer`).
  - **Optional:** `expires_in` (number, or a numeric string), `refresh_token` (string) and `scope`
    (a space- or comma-separated string; when absent, `buyer seller` is assumed). Without
    `expires_in`, the proxy never refreshes. It then relies on the backend's `401`.
  - **Errors:** `400 {"error": "...", "error_description": "..."}` and `401 {"error":"invalid_client"}`.
- **Identity:** right after the code exchange, `GET {EXCHANGENT_API_URL}/me` with
  `Authorization: Bearer <access_token>`. It must return `{ data: { actor_id, ... } }`.
  - A missing `actor_id` or a non-2xx response fails the sign-in.
  - mcp-use stores the profile at sign-in and doesn't re-read `/me` on each request.

### Run oauth mode locally

```sh
cd mcp
EXCHANGENT_AUTH=oauth \
EXCHANGENT_API_URL=http://127.0.0.1:8787/api/v1 \
EXCHANGENT_OAUTH_AUTHORIZE_URL=http://localhost:3000/oauth/authorize \
EXCHANGENT_OAUTH_TOKEN_URL=http://127.0.0.1:8787/api/v1/oauth/token \
EXCHANGENT_OAUTH_CLIENT_ID=... EXCHANGENT_OAUTH_CLIENT_SECRET=... \
MCP_USE_OAUTH_SECRET="$(openssl rand -base64 32)" \
npm run dev
```

With no `MCP_URL` and no Upstash, the server uses `memoryStorage()`, so sign-ins end on every
restart. Register `http://localhost:3100/mcp/oauth/callback` for the local client. HTTP endpoints
are accepted only on localhost. Then run
`claude mcp add --transport http exchangent-local http://localhost:3100/mcp`.

## Deploy to Manufact

The scaffold's `deploy` script runs `mcp-use deploy`. See
[Deploy to Manufact](https://docs.mcp-use.com/v2/typescript/server/deployment/mcp-use).
The existing server (`warm-pulse`, bearer mode) is linked in `.mcp-use/cloud/link.json`, which is
gitignored:

```sh
npx mcp-use login
cd mcp && npm run deploy -- --name exchangent-mcp --root-dir mcp \
  --env EXCHANGENT_API_URL=https://<public-backend>/api/v1
```

- Deploys run from a pushed GitHub branch, and the Manufact GitHub App needs access to the repo.
  On a dirty tree, `--yes` lets the CLI commit and push for you, so don't pass it casually.
- Set `EXCHANGENT_API_URL` to a backend the cloud can reach. Never set `EXCHANGENT_TOKEN` there.
- If the runtime doesn't set `HOST`, add `--env HOST=0.0.0.0` so the server listens publicly.
  `listen()` defaults to `127.0.0.1`.
- Use the exact MCP URL from the Manufact dashboard in client configs.

### Deploy the oauth server (a second Manufact server)

Run the same code as a separate server with `EXCHANGENT_AUTH=oauth`. **`--new` overwrites
`.mcp-use/cloud/link.json`**, so a later plain `npm run deploy` targets the new server. Back the
file up first and restore it afterwards:

```sh
cd mcp
cp .mcp-use/cloud/link.json .mcp-use/cloud/link.warm-pulse.json
# Secrets go in a gitignored env file (.env.production.local is in .gitignore):
cat > .env.production.local <<'ENV'
EXCHANGENT_AUTH=oauth
EXCHANGENT_API_URL=https://exchangent.vercel.app/api/v1
EXCHANGENT_OAUTH_AUTHORIZE_URL=https://<web-app>/oauth/authorize
EXCHANGENT_OAUTH_TOKEN_URL=https://exchangent.vercel.app/api/v1/oauth/token
EXCHANGENT_OAUTH_CLIENT_ID=<from npm run oauth:client>
EXCHANGENT_OAUTH_CLIENT_SECRET=<from npm run oauth:client>
UPSTASH_REDIS_REST_URL=<upstash rest url>
UPSTASH_REDIS_REST_TOKEN=<upstash rest token>
MCP_USE_OAUTH_SECRET=<openssl rand -base64 32>
HOST=0.0.0.0
ENV
npx mcp-use deploy --new --branch main --root-dir mcp --name exchangent-mcp-oauth \
  --env-file .env.production.local
cp .mcp-use/cloud/link.json .mcp-use/cloud/link.oauth.json
cp .mcp-use/cloud/link.warm-pulse.json .mcp-use/cloud/link.json
```

The same thing with inline flags (each `--env` is repeatable):
`npx mcp-use deploy --new --branch main --root-dir mcp --name exchangent-mcp-oauth --env EXCHANGENT_AUTH=oauth --env EXCHANGENT_OAUTH_AUTHORIZE_URL=... --env ...`.
Add `--yes` only for a non-interactive run, because it also authorizes git commits and pushes.

The public URL is known only after the first deploy, so a second step finishes the setup:

1. Copy the server's origin from the Manufact dashboard (for example `https://<server-host>`, with
   no `/mcp`).
2. Set `MCP_URL` to that origin: add `MCP_URL=https://<server-host>` to the env file and redeploy
   with the oauth link in place. Until `MCP_URL` is set, the server fails at startup with
   `OAuth listen() on a public or wildcard host requires an explicit provider resource or valid MCP_URL`.
3. Register `https://<server-host>/mcp/oauth/callback` as the client's redirect URI:
   `npm run oauth:client --prefix backend -- --name "Exchangent MCP" --redirect-uri https://<server-host>/mcp/oauth/callback`.
4. Connect: `claude mcp add --transport http exchangent https://<server-host>/mcp`, then `/mcp` in
   Claude Code to sign in.

The startup errors are explicit. A missing `EXCHANGENT_OAUTH_AUTHORIZE_URL`, client id or secret
is named. A public `MCP_URL` without Upstash, a missing secret or one shorter than 32 characters,
and an unknown `EXCHANGENT_AUTH` value each fail with their own message.

Google sign-in isn't configured here. People sign in on Exchangent's own page (InsForge, in `web/`),
so this server needs no Google Cloud OAuth client.

## Layout

```
mcp/
├── index.ts            # MCPServer (default export, used by mcp-use dev/build/start/deploy)
├── src/tools.ts        # 13 contract tools + whoami: zod input schemas, descriptions, backend route per tool
├── src/adapter.ts      # credential forwarding (bearer or oauth), idempotency keys, envelope + error/next mapping, $ formatting
├── src/auth.ts         # EXCHANGENT_AUTH mode, oauthProxy + Exchangent upstream, /me identity, storage choice
└── test/               # fake backend + fake Exchangent OAuth server (node:http) + MCP client end-to-end tests
```

## Verified local integration

With the backend running and `backend/.demo-principals.json` seeded, run
`npm run test:integration --prefix mcp` from the repository root. This explicit check
uses real InsForge data through MCP, negotiates a $465 offer down to $360, then
declines its test sessions. It creates no checkout or reservation.

Demo role tokens expire after 24 hours. The retired shared demo token is rejected.
See `backend/MANUFACT-HANDOFF.md` for the reconciled setup and remaining deployment steps.
