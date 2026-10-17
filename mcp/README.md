# Exchangent MCP server

MCP server built with [mcp-use](https://github.com/mcp-use/mcp-use) (v2.10.1). It exposes the
buyer and seller negotiation tools from [`doc/negotiation-contract.md`](../doc/negotiation-contract.md)
and forwards every call to the backend HTTP API. It is a thin adapter: the backend enforces every
rule (role, turn, version, budget, floor, stock) and is the source of truth.

- Transport: Streamable HTTP at `http://127.0.0.1:3100/mcp` (`PORT` overrides 3100).
- Backend: `EXCHANGENT_API_URL` (default `http://127.0.0.1:8787/api/v1`).
- Auth: the caller's `Authorization: Bearer <token>` header on the MCP HTTP request is forwarded
  to the backend. The token decides whether you are a buyer or a seller. `EXCHANGENT_TOKEN` is a
  dev-only fallback, used only when the MCP request has no `Authorization` header.

## Run locally

```sh
cd mcp
npm install
cp .env.example .env          # optional; edit EXCHANGENT_API_URL / PORT
npm run dev                   # mcp-use dev: hot reload + Inspector at http://127.0.0.1:3100/mcp/inspector
# or production mode:
npm run build && npm start    # serves .mcp-use/build on PORT (default 3100)
npm run typecheck
npm test                      # fake backend + MCP client end-to-end tests (no real backend needed)
```

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

### claude.ai custom connector (and Desktop's Connectors UI)

Custom connectors need a public HTTPS URL, such as a Manufact deployment or
`npm start -- --tunnel`. They authenticate with OAuth, and you can't add a static
`Authorization` header. This server has no OAuth yet, so a connector would reach it without a
header. The backend then returns `unauthorized`. Don't work around this by setting
`EXCHANGENT_TOKEN` on a public deployment, because every caller would act as that principal.
Supporting connectors properly means adding mcp-use OAuth (`mcp-use/oauth`) that maps an
identity to a backend principal. For the demo, use Claude Code or the Desktop `mcp-remote`
bridge.

## Deploy to Manufact (not done yet)

The scaffold's `deploy` script runs `mcp-use deploy`. See
[Deploy to Manufact](https://docs.mcp-use.com/v2/typescript/server/deployment/mcp-use).

```sh
npx mcp-use login
cd mcp && npm run deploy -- --name exchangent-mcp --root-dir mcp \
  --env EXCHANGENT_API_URL=https://<public-backend>/api/v1
```

- Deploys run from a pushed GitHub branch, and the Manufact GitHub App needs access to the repo.
  `--yes` lets the CLI commit and push for you, so don't pass it casually.
- Set `EXCHANGENT_API_URL` to a backend the cloud can reach. Never set `EXCHANGENT_TOKEN` there.
- The first deploy writes `.mcp-use/cloud/link.json`, which later deploys reuse. That folder is
  gitignored with the rest of `.mcp-use/`.
- If the runtime doesn't set `HOST`, add `--env HOST=0.0.0.0` so the server listens publicly.
  `listen()` defaults to `127.0.0.1`.
- Use the exact MCP URL from the Manufact dashboard in client configs.

## Layout

```
mcp/
├── index.ts            # MCPServer (default export, used by mcp-use dev/build/start/deploy)
├── src/tools.ts        # 13 tools: zod input schemas, descriptions, backend route per tool
├── src/adapter.ts      # bearer forwarding, idempotency keys, envelope + error/next mapping, $ formatting
└── test/               # fake backend (node:http) + MCP client end-to-end tests
```

## Verified local integration

With the backend running and `backend/.demo-principals.json` seeded, run
`npm run test:integration --prefix mcp` from the repository root. This explicit check
uses real InsForge data through MCP, negotiates a $465 offer down to $360, then
declines its test sessions. It creates no checkout or reservation.

Demo role tokens expire after 24 hours. The retired shared demo token is rejected.
See `backend/MANUFACT-HANDOFF.md` for the reconciled setup and remaining deployment steps.
