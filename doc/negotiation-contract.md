# Negotiation integration contract

Shared contract for the negotiation loop. It extends `backend/CONTRACT.md`, the backend owner's
contract, and must not break it. Three packages build against this file in parallel:

| Package | Owns | Port |
|---|---|---|
| `backend/` + `migrations/` | Negotiation schema, RPCs, HTTP routes, principals, demo seed | 8787 |
| `mcp/` | mcp-use MCP server exposing buyer and seller tools; forwards calls to the backend | 3100 |
| `agents/` | Agent runner: spins up Inkbox identities on demand, dispatches outbox events, runs the agent brain | 8080 (local transport) |

## The loop

```
Buyer (Claude Desktop) ──MCP──► create_buy_order ──► backend: request + matched sessions + outbox "session.opened"
agents/dispatcher polls GET /worker/events
   └─► transport (Inkbox A2A, or a local in-process queue) delivers to the seller agent; its Inkbox identity is created on demand
seller brain (claude -p with our MCP server | scripted mock) ──MCP──► get_negotiation, make_offer
   └─► backend: offer v1 + outbox "offer.created" ──► dispatcher ──► buyer agent
buyer brain ──MCP──► counter_offer (≤ private budget) ──► outbox "counter.created" ──► seller agent ...
... until: seller offer acceptable → buyer agent stops; the human calls reserve_offer + get_checkout_link (existing Stripe flow)
```

Only plain code sends messages. A model never sends a message itself. Every message is a side effect of a
backend mutation that commits together with an outbox row.

## Design rules

- **Buyer counters are a separate table, `commerce_counters`.** `commerce_offers` holds seller-authored offers
  only, so the existing `commerce_reserve` stays correct without changes: a buyer can reserve only a seller offer.
- **A seller "accepts" a counter** by making a new offer at the countered price.
- **Turn-taking and staleness** are tracked by `commerce_sessions.version`. Every mutation sends
  `expected_version`. If it doesn't match, the call fails with `stale_offer`, and the agent re-reads the session.
- **Money** is integer cents. Seller offers set `unit_cents` per line item and `delivery_cents`. Demo tax is
  `tax_cents = 0`. The total is computed on the server.
- **Redaction:**
  - A buyer never sees floors, other buyers' requests or seller policy.
  - A seller never sees `budget_cents` or `target_cents`.
  - A seller sees its own floors, because those are its own private data.
  - Outbox payloads contain only IDs, kinds and public totals. They never contain budgets or floors.
- **Response envelope** (same as backend/CONTRACT.md): `{ data }` or `{ error: { code, message, next_action } }`.
  Mutations require an `Idempotency-Key` header.

## Schema additions (new migration, additive only, no drops)

- `commerce_sellers`: add
  - `service_area text default 'san_francisco'`
  - `delivery_cents int default 0`
  - `delivery_days int default 2`
  - `agent_handle text` (Inkbox handle, set when the identity is created)
- `commerce_inventory`: add `list_cents int`, `category text` (`desk` | `chair`), `attributes jsonb default '{}'`
  (for example `{"width_in": 46}`)
- `commerce_requests`: add
  - `title text`
  - `requirements jsonb not null default '{}'`
  - `target_cents int` (private)
  - `deadline timestamptz`
  - `delegate_negotiation boolean default true`
  - `idempotency_key text`, with `unique(buyer_id, idempotency_key)`
  - `created_at timestamptz default now()`
- `commerce_offers`: add
  - `session_id uuid` references commerce_sessions
  - `note text`
  - `idempotency_key text`
  - `created_at timestamptz default now()`
- New table `commerce_sessions`:
  - `id`, `request_id`, `seller_id`
  - `status` (`open` | `declined` | `closed`)
  - `turn` (`seller` | `buyer`)
  - `version int default 0`
  - `rounds int default 0`
  - `latest_offer_id`, `latest_counter_id`
  - `declined_by`, `decline_reason`, `created_at`
  - `unique(request_id, seller_id)`
- New table `commerce_counters`:
  - `id`, `session_id`, `buyer_id`, `responding_to_offer_id`
  - `total_cents`, `note`, `version`
  - `idempotency_key`, `created_at`
- New table `commerce_principals`:
  - `token_hash text primary key` (sha256 hex of the bearer token)
  - `actor_id`
  - `scope` (`buyer` | `seller` | `worker`)
  - `seller_id` (nullable)
  - `label`
- RLS and revokes on every new table and function, matching the existing migration's pattern.

## HTTP API (all under `/api/v1`, `Authorization: Bearer <token>`)

The backend resolves the token to a principal: sha256 the token, then look it up in `commerce_principals`.
The legacy `COMMERCE_DEMO_TOKEN` still resolves to the buyer `DEMO_BUYER_ID`.

### Buyer scope

| Method and path | Body | Returns |
|---|---|---|
| `POST /buy-requests` | `{ title, requirements, budget_cents, target_cents?, deadline?, delegate_negotiation? }` | `{ request_id, status, sessions: [{ session_id, seller_id, seller_name }] }` |
| `GET /buy-requests/:id` | | Request projection: status and requirements, plus the buyer's own budget and target. `sessions[]` lists each session's status, turn, version and rounds, plus `current_offer` (with item titles) and `latest_counter` |
| `GET /buy-requests/:id/offers` | | Current seller offers, sorted by total |
| `POST /sessions/:id/counters` | `{ expected_version, total_cents, note }` | `{ counter_id, session_version }`. Errors: `budget_exceeded`, `stale_offer`, `not_your_turn`, `session_closed` |
| `POST /sessions/:id/decline` | `{ reason }` | `{ session_id, status: "declined" }` |
| (existing) `POST /offers/:id/reservations`, `POST /reservations/:id/checkout`, `GET /reservations/:id` | | Unchanged |

`requirements` shape:

```json
{
  "region": "san_francisco",
  "deliver_by": "2026-10-18",
  "items": [
    { "category": "desk", "max_width_in": 48 },
    { "category": "chair", "ergonomic": true }
  ]
}
```

### Seller scope

| Method and path | Body | Returns |
|---|---|---|
| `GET /seller/sessions?status=open` | | The seller's sessions with request title, requirements, turn, version and rounds |
| `GET /sessions/:id` | | The projection for the caller's role. Seller view: requirements, the full history of offers and counters with notes, turn and version |
| `GET /seller/inventory` | | The seller's own inventory with `list_cents`, `floor_cents`, `available`, `category` and `attributes` |
| `POST /sessions/:id/offers` | `{ expected_version, items: [{ inventory_id, quantity, unit_cents }], delivery_cents, note }` | `{ offer_id, version, total_cents, session_version }`. Errors: `below_floor`, `out_of_stock`, `stale_offer`, `not_your_turn`, `session_closed`, `invalid_input` |
| `POST /sessions/:id/decline` | `{ reason }` | Same as the buyer version |

### Worker scope

| Method and path | Returns |
|---|---|
| `GET /worker/events?limit=20` | Undelivered outbox rows, oldest first: `[{ id, kind, created_at, payload, route: { to_role: "seller" \| "buyer", seller_id?, buyer_id?, agent_handle? } }]` |
| `POST /worker/events/:id/ack` | Marks the row delivered. Idempotent |
| `POST /worker/sellers/:id/agent` | `{ agent_handle }`: records the Inkbox handle once the runner creates the identity |

Outbox kinds and payloads (no private numbers):

| Kind | Sent to | Payload |
|---|---|---|
| `session.opened` | seller | `{ session_id, request_id }` |
| `offer.created` | buyer | `{ session_id, request_id, offer_id, total_cents, note }` |
| `counter.created` | seller | `{ session_id, counter_id, total_cents, note }` |
| `session.declined` | the other party | `{ session_id }` |

## MCP tools (`mcp/`, built with mcp-use)

The MCP server forwards the caller's `Authorization` header to the backend. Each tool returns
`{ status, ...data, next }`, a short sentence telling the agent what to do next. Errors are returned as tool
results, not thrown exceptions, and use the same `next` hint.

**Buyer tools:**
- `create_buy_order`
- `get_buy_order`
- `list_offers`
- `counter_offer`
- `decline_seller`
- `reserve_offer`
- `get_checkout_link`
- `get_reservation_status`

**Seller tools:**
- `list_my_requests`
- `get_negotiation`
- `get_inventory`
- `make_offer`
- `decline_request`

## Agents (`agents/`)

- **Transport interface:**
  - `send(fromRole, toAgent, event)`
  - `onMessage(agent, handler)`
  - `TRANSPORT=local` uses an in-process queue, so no Inkbox keys are needed.
  - `TRANSPORT=inkbox` sends A2A messages through `@inkbox/sdk`. The sender is the counterparty agent's
    identity. Inbound messages arrive as webhooks through the identity's tunnel; the handler checks the
    signature, skips duplicate event IDs, and routes the event to that agent's mailbox.
- **Identities on demand:** the first event for a seller with no `agent_handle` creates an Inkbox identity
  and registers it with `POST /worker/sellers/:id/agent`.
- **One event at a time per agent.** The brain always re-reads the current state through MCP. It never trusts
  the numbers in a message.
- **Brain implementations** (selected with `BRAIN=...`):
  - `mock`: scripted MCP calls with zero tokens.
    - The seller opens at list price and gives 5% per round, never going below its floor.
    - The buyer counters at its target, then splits the difference, and stops once an offer is at or under
      its target or after 3 rounds.
  - `claude`: runs `claude -p` with `--mcp-config` pointing at our MCP server and the agent's bearer token, an
    allowlist of `mcp__exchangent__*` tools, and a per-agent persona prompt. It uses whatever Claude Code
    login exists on the machine.
- **Credentials** come from `agents/.env.local`, plus the demo tokens file the seed script writes. Nothing is
  committed.

## Demo seed (`backend/scripts/seed-negotiation.mjs`)

Creates one buyer and three sellers in San Francisco, each with desks and chairs: list price, floor, width and
stock. It also creates one bearer token per buyer, per seller and for the worker, and writes them to
`backend/.demo-principals.json` (gitignored).
