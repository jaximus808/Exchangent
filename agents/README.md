# Exchangent agent runner (`agents/`)

This package runs the seller agents and the buyer agent. It does three things in a loop:

1. Polls the backend outbox (`GET /api/v1/worker/events`) with the worker token.
2. Delivers each event to the agent it is for: the seller named in `route.seller_id`, or the buyer agent. The
   message is sent from the counterparty agent. The runner acks the event (`POST /worker/events/:id/ack`) only
   after the transport has accepted it.
3. Gives each agent one mailbox. Events are processed one at a time, and each event is one brain turn. A brain
   always re-reads state through the MCP server and never uses the numbers in a message.

The spec is in `doc/negotiation-contract.md`, in the "Agents" section.

## Run

```bash
cd agents
npm install
cp .env.example .env.local      # adjust if needed
npm start
```

The runner is TypeScript that Node runs directly (type stripping, Node 22.18 or later); there is no build step.
`npm run typecheck` runs `tsc --noEmit` over `src/`, `scripts/` and `test/`.

Before you start, the backend must be running on port 8787 and seeded, and the MCP server must be running at
`MCP_URL` (`http://127.0.0.1:3100/mcp` by default). The seed script writes `backend/.demo-principals.json`
with the buyer, seller and worker tokens. The runner reads that file (`PRINCIPALS_FILE`).

| `TRANSPORT` | `BRAIN` | What you get |
|---|---|---|
| `local` | `mock` | In-process queues and scripted MCP calls. No keys and no tokens are needed, so this mode is good for rehearsing the demo. |
| `local` | `claude` | Real model turns (`claude -p`) with no Inkbox setup. |
| `inkbox` | `mock` | Real Inkbox A2A messages and tunnels, with scripted brains. |
| `inkbox` | `claude` | Full live demo. |

Logs print one line per delivery and per turn, for example `OFFER concedes 5%`, `COUNTER splits the difference`
and `READY TO RESERVE: offer <id>`. Set `LOG_FORMAT=json` to get one JSON object per line instead.

### Who the buyer agent negotiates for

- **`buyer_agent` token** (`npm run agents:tokens --prefix backend`, file `backend/.agent-principals.json`): the
  platform buyer agent. It negotiates every order whose buyer left `delegate_negotiation` on (the default), for
  any account, using the worker feed's `route.delegated`.
- **`buyer` token** (the demo seed): only that one buyer's orders.
- **Orders the agent doesn't negotiate:** their buyer-bound events are acked without delivery, because that
  person negotiates in chat. Their seller-bound events have no sender; with `TRANSPORT=inkbox` they are
  delivered in-process.
- **`SKIP_BACKLOG=1`:** acks events created before the runner started, without delivering them.
- **Deal email:** when a buyer turn ends ready to reserve (the mock brain's `ready`, or Claude's
  `READY TO RESERVE: <offer_id>`), `src/notify.ts` re-reads the order and emails the buyer once.
  - The address comes from `buyer_email`, which only the buyer agent's view has.
  - With `TRANSPORT=inkbox` it is sent from the buyer agent's own mailbox; with `local` it is only logged.

### Mock brain rules

- **Seller.** It calls `get_negotiation` and `get_inventory`. For each requirement line it picks the cheapest
  in-stock item that meets the line: `max_<attr>` and `min_<attr>` are compared with `attributes.<attr>`, and
  booleans must match exactly.
  - Its first offer is at list price.
  - Each later offer drops each item's unit price by 5% from the previous offer, but never below that item's
    floor.
  - If the buyer's latest counter is at or above the bundle minimum (sum of floors plus delivery), it calls
    `make_offer` at exactly the counter total.
  - If it has no matching stock, it calls `decline_request`.
- **Buyer.** On `offer.created` it reads `get_buy_order`. It stops and logs `READY TO RESERVE: offer X` if any
  current offer meets one of these conditions:
  - It is at or below the target.
  - It is at or below the buyer's own latest counter in that session, meaning the seller met the counter.
  - It is within the budget and the session has reached round 3 (`rounds >= 3`; the backend counts seller
    offers).

  Otherwise it calls `counter_offer`. The first counter is at the target. After that, each counter is halfway
  between its last counter and the seller's current offer, and never above the budget or the offer. After 8
  rounds it calls `decline_seller`. It never reserves; the human calls `reserve_offer` and
  `get_checkout_link`.

## Going live with Inkbox (`TRANSPORT=inkbox`)

1. **Admin key.** Create an admin-scoped API key in the Inkbox Console and set it as `INKBOX_API_KEY` in
   `.env.local`. Only this runner uses the admin key, never a brain. With it, the runner:
   - creates identities with `createIdentity`;
   - mints one **agent-scoped** key per identity with `apiKeys.create({ scopedIdentityId })`, because the A2A
     protocol endpoint rejects admin keys;
   - creates webhook subscriptions;
   - brings tunnels online.
2. **Identities on demand.** The first event that involves an agent creates its identity: `exchangent-buyer`,
   or `exchangent-<seller-name-slug>` for a seller. The runner then:
   - mints the agent's key and enables A2A (on by default for identities your organization creates; the call
     also returns the canonical Agent Card URL, `https://inkbox.ai/a2a/<handle>/card`, which is stored);
   - subscribes `a2a.task.created` and `a2a.task.message` to `https://<handle>.inkboxwire.com/inkbox/webhook`;
   - for sellers, registers the handle with `POST /api/v1/worker/sellers/:id/agent`.

   Handles are unique across all Inkbox customers. If a handle is taken by another organization, the runner
   adds a random 4-character suffix. You can also change `INKBOX_HANDLE_PREFIX`.
3. **Identity cap.** The free plan allows 3 identities. The demo needs one identity for the buyer plus one per
   seller, so it needs 4 with three sellers. `INKBOX_IDENTITY_CAP` (default 3) is checked before any identity
   is created. When the cap is reached, that seller's events fail with a clear `IdentityCapError` and stay
   unacked, so they are retried. The other sellers keep negotiating. An HTTP 402 from Inkbox produces the same
   error. To run more sellers, upgrade the plan (Developer allows 10) and raise the cap, or seed fewer sellers.
4. **Tunnels.** Each identity's tunnel comes online inside this process through
   `@inkbox/sdk/tunnels/connect`, using an in-process handler. No public URL or port forwarding is needed.
   `connect()` only bootstraps the tunnel; the runner then calls `serveForever()` (which reconnects with backoff)
   and waits up to 30 seconds for `connected`. Only one process can hold a tunnel: a second process that
   connects takes it over, so do not run the runner and the smoke test (below) at the same time.
   For each webhook, the handler:
   - checks `X-Inkbox-Timestamp` (300-second window) and the HMAC signature (SDK `verifyWebhook`, keyed with
     the identity's signing key);
   - dedupes by the webhook `id`;
   - accepts only callers that are our own identities (`data.sender`, else `data.caller`), and ignores its own
     replies;
   - acks the A2A task in the background with `a2aReply(taskId, { intent: "complete" })`;
   - pushes the event into the agent's mailbox, which dedupes again by outbox event id.

   On restart, tasks that are still `submitted` are fetched from each identity's inbox and replayed.
5. **Messages.** Each outbox event becomes one A2A message from the counterparty agent's identity to the
   recipient's identity:
   - `messageId` is the outbox event id, which Inkbox uses as an idempotency key.
   - `contextId` is one per negotiation session.
   - The `data` part holds `{ kind, event_id, created_at, session_id, request_id?, offer_id?, counter_id?,
     total_cents? }`.
   - A short `text` part follows. Notes appear only in the text part.
6. **State.** Local state is stored in `agents/.state/identities.json`, which is gitignored and has file mode
   0600. It holds:
   - the handles and identity IDs;
   - the agent-scoped keys and signing secrets (Inkbox shows these only once);
   - the subscription IDs;
   - the A2A context per session.

   Tunnel state is stored in `agents/.state/tunnels/<handle>/`. If the file is lost, the runner adopts the
   existing identities in your organization by handle and rotates their signing keys.
7. **Smoke test.** Before the demo, check the live path with `npm run inkbox:smoke` (it reads `.env.local`).
   It uses the same agent ids and handles as the runner, so it creates or reuses only the buyer identity and
   the "Bay Desk Co" identity (`-- --seller "<name>"` picks another seller). It sends a synthetic
   `session.opened` from the buyer to the seller and an `offer.created` back, through real A2A, tunnels and
   signed webhooks, then prints PASS or FAIL with handles and timings. It never calls the backend; the seller's
   handle registration is left for the runner. If a delivery times out, the script prints the recipient's
   recent webhook deliveries from Inkbox's delivery log. You can also see each identity's A2A tasks and the
   webhook delivery log in the [Inkbox Console](https://inkbox.ai/console). Exit codes are 0 for pass, 1 for
   fail, and 2 for missing setup (no `INKBOX_API_KEY`, or no principals file because the demo has not been
   seeded).

## BRAIN=claude

Each turn runs:

```
claude -p "<turn prompt: event kind + IDs only>" \
  --mcp-config .state/claude/<agent>/mcp.json --strict-mcp-config \
  --allowedTools "mcp__exchangent__*" --permission-mode dontAsk \
  --output-format json --no-session-persistence \
  --append-system-prompt "<persona>"   [buyer: --disallowedTools reserve_offer get_checkout_link create_buy_order]
```

The command runs in `agents/.state/claude/<agent>/`. That directory also contains the persona as `CLAUDE.md`:

- **Seller persona:** sell within floors, be concise, and always finish a turn with `make_offer` or
  `decline_request`.
- **Buyer persona:** never reveal the budget and negotiate toward the target.

`mcp.json` points at `MCP_URL` with `Authorization: Bearer <that agent's token>`. The file has mode 0600, and
the token is never passed as a command-line argument.

**Credentials:** `BRAIN=claude` uses the Claude Code login that already exists on this machine. Inkbox never
receives Claude credentials. Inkbox only carries A2A messages that contain IDs and public totals. The model
never sends messages itself. Its only actions are MCP mutations, and the backend turns those into outbox rows.

## Tests

```bash
npm test             # node --test test/*.test.ts
npm run typecheck    # tsc --noEmit
```

- **`negotiation.e2e.test.ts`:** runs a full negotiation with `TRANSPORT=local BRAIN=mock`. It uses a fake
  backend (the worker HTTP endpoints) and a fake MCP server (real MCP over Streamable HTTP, built with
  `@modelcontextprotocol/sdk`). The flow is `session.opened` → list offer → counter at target → 5% concession
  → split the difference → seller meets the counter → `READY TO RESERVE`. The test also checks:
  - Outbox totals are deliberately tampered with, and the agents still behave correctly.
  - The first ack fails, and the redelivered event is deduped.
  - Every MCP call uses the calling agent's own bearer token.
- **`inkbox.test.ts`:** tests the Inkbox transport with a mocked SDK, so it makes no network calls and needs
  no keys. It covers:
  - signature verification with the real SDK `verifyWebhook`;
  - creating identities on demand, minting agent-scoped keys and registering handles;
  - the A2A message shape and context reuse;
  - deduplication;
  - the identity cap and HTTP 402 handling;
  - adopting existing identities after local state is lost;
  - tunnels started with `serveForever()`, and replaying tasks that are still `submitted` after a restart.
- **`claude.test.ts`:** checks how the command is built, and checks with `claude --help` that the installed CLI
  still accepts every flag. It never runs a real turn.
- **`mock-brain.test.ts`:** checks the pricing and decision rules.

## Integration assumptions

These were checked against the in-progress `mcp/src/tools.ts`, `mcp/src/adapter.ts` and
`migrations/20261017230000_negotiation.sql`, as they stood when this package was written.

- **MCP tool arguments** match `mcp/`:
  - `get_negotiation({ session_id })`
  - `get_inventory({})`
  - `make_offer({ session_id, expected_version, items: [{ inventory_id, quantity, unit_cents }], delivery_cents, note })`
  - `decline_request({ session_id, reason })`
  - `get_buy_order({ request_id })`
  - `counter_offer({ session_id, expected_version, total_cents, note })`
  - `decline_seller({ session_id, reason })`
- **Results** are read from `structuredContent`, which has `status` (`ok` or `error`), `next`, and on failure
  `error.code`. If `structuredContent` is missing, the runner parses the JSON text instead.
  - `mcp/` renames the backend's top-level `status` to `session_status` for `get_negotiation` and to
    `request_status` for `get_buy_order`.
  - Sessions nested inside `get_buy_order` keep their own `status`.
- **Seller view:**
  - The runner reads `turn`, `version`, `request.requirements` and `seller.delivery_cents`.
  - It reads `current_offer.items[].unit_cents` and `latest_counter.total_cents`.
  - It reads `history[]` entries with `type: "offer"` or `type: "counter"`.
- **`rounds`** comes from the backend. The backend increments it on each **seller offer**, so the buyer rule
  "anything within budget is acceptable from round 3" applies from the seller's third offer onward.
- **Routing:**
  - The backend's `GET /worker/events` sets `route.seller_id` and `route.request_id` on every event. Buyer-bound
    events use `route.seller_id` to pick the sending Inkbox identity.
  - `route.request_id` is copied into the message payload, because `counter.created` and `session.declined`
    payloads do not include it.
  - `route.agent_handle`, when present, is the preferred handle when an identity is created.
- **Envelopes:** `GET /worker/events` may return `data: [...]` or `data: { events: [...] }`. `BACKEND_URL` may
  include `/api/v1` or not.
