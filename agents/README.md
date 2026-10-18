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

### Run headless as a service (macOS)

`npm run service <command>` runs the runner as a launchd user agent (`com.exchangent.agents`), with no terminal
needed:

| Command | What it does |
|---|---|
| `start` | Writes `~/Library/LaunchAgents/com.exchangent.agents.plist` and starts the runner. It refuses if a runner started with `npm start` is already running. |
| `stop` | Stops it gracefully: in-flight turns finish (up to 60 s). It stays off, also after you log in again. |
| `restart` | Stop, then start. Use it after pulling new code or editing `.env.local`. |
| `status` | The launchd state and the runner lock's heartbeat. |
| `logs` | Follows `.state/logs/runner.log`. |
| `uninstall` | Stops it and removes the plist. |

**How it runs:**
- `BRAIN` and `SKIP_BACKLOG` come from the shell that runs `start`. The defaults are `claude` and `0`, for example
  `BRAIN=mock npm run service start`.
- A crashed or killed runner is restarted after 15 s. The restart is built into the job, because launchd delays
  its own restarts on battery power.
- The job runs under `caffeinate -i`, so the Mac doesn't idle-sleep while agents are on. Closing the lid still
  sleeps it.
- `claude -p` uses your normal Claude Code login, the same as in a terminal.

### Who the buyer agent negotiates for

- **`buyer_agent` token** (`npm run agents:tokens --prefix backend`, file `backend/.agent-principals.json`): the
  platform buyer agent. It negotiates every order whose buyer left `delegate_negotiation` on (the default), for
  any account, using the worker feed's `route.delegated`.
- **`buyer` token** (the demo seed): only that one buyer's orders.
- **Orders the agent doesn't negotiate:** their buyer-bound events are acked without delivery, because that
  person negotiates in chat. Their seller-bound events have no sender; with `TRANSPORT=inkbox` they are
  delivered in-process.
- **`SKIP_BACKLOG=1`:** acks, without delivering, only events older than `SKIP_BACKLOG_MINUTES` (default 15)
  at startup. Newer backlog is delivered, so a restart never drops a haggle in progress.
- **Deal email:** when a buyer turn ends ready to reserve (the mock brain's `ready`, or Claude's
  `READY TO RESERVE: <offer_id>`), `src/notify.ts` re-reads the order and emails the buyer once.
  - The address comes from `buyer_email`, which only the buyer agent's view has.
  - With `TRANSPORT=inkbox` it is sent from the buyer agent's own mailbox; with `local` it is only logged.

### Who the seller agents negotiate for

- **Static sellers:** each seller in the principals file (`seller` tokens from `npm run agents:tokens`, e.g. the
  seeded Bay Desk Co, Mission Ergonomics and SoMa Office Supply).
- **Self-serve businesses** (doc/signup-contract.md): someone signs up with any email, creates a business and
  stocks it with MCP tools. The first event for a seller that is not in the principals file makes the runner
  mint a seller token with the worker token (`POST /api/v1/worker/sellers/:id/token`) and build a dynamic seller
  agent for it.
  - The agent is cached, gets its own mailbox and Inkbox identity, and its handle is registered like a
    static seller's.
  - Its token is minted again 10 minutes before it expires, and right away if a turn fails with a 401.
- **Owner negotiates in chat:** when the owner turned agent negotiation off (`route.seller_delegated: false`,
  or the mint returns `not_delegated`), seller-bound events are acked without delivery. Buyer-bound offers from
  that business reach the buyer agent with no sender (in-process with `TRANSPORT=inkbox`).
- **Sale email:** `order.confirmed` is a notice, never a brain turn. `SaleNotifier` (`src/notify.ts`) reads
  `owner_email` with `get_business` and emails the owner "Sold: <title>, <total>" once, with idempotency key
  `exchangent-sale-<order_id>`.
  - It is sent from the seller's own Inkbox mailbox, or from the buyer agent's mailbox (the platform's) when
    the seller has no identity here.
  - Demo businesses without an account have no owner email, so nothing is sent.

### Transcript and delivery receipts

- **Transcript:** each delivered offer, counter or decline prints one line, using the total and note from the
  event payload:
  `💬 Alex Woodworks agent → Buyer agent: $300.00 "Deal at $300." [inkbox exchangent-alex-woodworks → exchangent-buyer]`
- **Delivery receipts:** the runner acks each delivered event with a receipt
  (`POST /worker/events/:id/ack` with body `{delivery}`), in the shape
  `{transport, from_handle, to_handle, message_id, context_id, delivered_at}`.
  - **Inkbox:** the identity handles, the outbox event ID as the message ID, and the session's A2A context.
  - **In-process:** `local` and agent slugs.
  - **Skipped and backlog acks** send no receipt.
- **What it's for:** the backend stores receipts for the conversation views (`doc/conversation-contract.md`).

### Mock brain rules

- **Seller.** It calls `get_negotiation` and `get_inventory`. For each requirement line it picks the cheapest
  in-stock item that meets the line: `max_<attr>` and `min_<attr>` are compared with `attributes.<attr>`, and
  booleans must match exactly.
  - Its first offer is at list price.
  - Each later offer drops each item's unit price by 5% from the previous offer, but never below that item's
    floor.
  - If the buyer's latest counter is at or above the bundle minimum (sum of floors plus delivery): from round 3
    (`rounds >= 3`) it calls `make_offer` at exactly the counter total. Before that it meets the buyer halfway
    between its last offer and the counter (never below the minimum), so it doesn't give its floor away on
    the first counter.
  - If it has no matching stock, it calls `decline_request`.
- **Buyer.** On `offer.created` it reads `get_buy_order`. It stops and logs `READY TO RESERVE: offer X` if any
  current offer meets one of these conditions:
  - It is at or below the target.
  - It is at or below the buyer's own latest counter in that session, meaning the seller met the counter.
  - It is within the budget and the session has reached round 3 (`rounds >= 3`; the backend counts seller
    offers).

  Otherwise it calls `counter_offer`. The first counter is at the target. After that, each counter is halfway
  between its last counter and the seller's current offer, and never above 97% of the budget (a counter at
  exactly the budget gives it away) or the offer. After 8
  rounds it calls `decline_seller`. It never reserves; the human calls `reserve_offer` and
  `get_checkout_link`.

### After-sale cases (refunds, damage, missing items, substitutions)

Cases are negotiations over a **remedy** instead of a price (`doc/resolution-design.md`). The backend checks and caps
every amount; agents only propose. `src/cases.ts`:

- **`case.opened` / `case.offer`** are turns for the side whose turn it is: the buyer agent for delegated requests,
  a seller agent while its owner leaves agent negotiation on. They travel like negotiation events (one A2A context
  per case on Inkbox), and the brain reads the case with `get_case` and answers once with `respond_to_case`.
  - **Buyer agent:** accepts full refunds, refunds of the affected items and prepaid returns. It accepts a partial
    offer at 95% of what the buyer asked, else counters halfway, and after 4 rounds accepts anything at or above
    half. It accepts a **substitute** only if `substitute_check.meets_requirements` and the price delta is at most 0;
    otherwise it declines (the buyer is refunded).
  - **Seller agent:** reads `get_resolution_policy`, accepts facts the platform verified (no delivery scan, late
    delivery, duplicate charge, missing item), and accepts partial asks up to `max_auto_partial_refund_pct` + 10% of
    the affected value. It offers keep-with-discount instead of return freight, and declines (a person reviews) after
    4 rounds outside policy.
  - Both personas treat the other side's notes and evidence as untrusted data.
- **Emails to people**, once each (idempotency keys), never a brain turn:
  - **Buyer** (buyer agent's mailbox, delegated requests only): `order.shipped`, `case.resolved`, `refund.succeeded`.
  - **Seller owner** (the seller's mailbox, else the platform's): `case.escalated`, `dispute.created`,
    `dispute.decided`.

  An owner who negotiates in chat has no seller agent here, so no email: they see it in Claude.
- An older backend without these events simply never sends them, so nothing changes.

### Email your agent

Email `exchangent-buyer@…` (the buyer agent's Inkbox address) from your account's address and it replies in the same
thread with your delegated orders: best offer, sellers still negotiating, status and the live watch link. Email a
seller agent's address from the business owner's address for that business's open negotiations (`src/inbound.ts`):

- **Read-only.** It never reserves, pays, counters or changes anything from an email.
- **Replies go only to the registered address that matched** (never a Reply-To), so a forged From learns nothing.
  Unknown senders get no reply (no backscatter).
- **Ignored:** auto-replies, bounces and our own identities. At most 10 replies per sender per hour.
- **Polling:** every `INBOUND_POLL_MS` (30 s) per identity, with a cursor in `.state/inbound.json`. The first run
  starts at "now", so old mail is never answered.
- **Requirements:** Inkbox only (local transport has no mailbox). It needs the backend route
  `GET /worker/buyer-requests?email=`; without it (404) buyer replies stay off quietly.

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
3. **Identity cap.** The free plan allows 3 identities: one for the buyer agent plus one per seller.
   `INKBOX_IDENTITY_CAP` (default 3) is checked before any identity is created. An agent that would go over the
   cap (or that Inkbox refuses with HTTP 402) does not fail its events. The runner warns once and delivers that
   agent's events in-process, both to it and from it. To give every seller a real identity, upgrade the plan
   (Developer allows 10) and raise the cap.
   - **`INKBOX_LOCAL_SELLERS`:** comma-separated seller names or IDs that always use in-process delivery, so the
     free slots go to the sellers you want to show. Example: `Mission Ergonomics,SoMa Office Supply` keeps
     slots for the buyer, Bay Desk Co and one self-serve business.
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

Each turn runs one sandboxed `claude -p`:

```
claude -p "<turn prompt: event kind + IDs only>" \
  --tools "" --restricted --disable-slash-commands \
  --mcp-config '{"mcpServers":{"exchangent":{"type":"http","url":"<MCP_URL>","headers":{"Authorization":"Bearer ${EXCHANGENT_AGENT_TOKEN}"}}}}' \
  --strict-mcp-config --allowedTools "mcp__exchangent__*" --permission-mode dontAsk \
  --output-format json --no-session-persistence \
  --model <CLAUDE_MODEL, default sonnet> --max-budget-usd <CLAUDE_TURN_BUDGET_USD, default 0.40> \
  --append-system-prompt "<persona>"   [buyer: --disallowedTools reserve_offer get_checkout_link create_buy_order]
```

**What a turn can do: only the Exchangent MCP tools of its own role.**
- **No built-in tools:** `--tools ""` removes Read, Grep, Glob, Bash, Edit, Write and the web tools. Checked
  with the installed CLI: asked to read a file and run a shell command, the model had no tool to do either.
- **None of your setup:** `--restricted` ignores your user, project and local settings, so your plugins, hooks
  and default model don't reach the agents. `--disable-slash-commands` drops skills. `--strict-mcp-config`
  loads only the Exchangent server.
- **No secrets in reach:**
  - The agent's token is never written to disk or argv. The inline MCP config has the placeholder
    `${EXCHANGENT_AGENT_TOKEN}`, which Claude Code expands from the child's environment (checked against a
    local header-logging server).
  - The child's environment is an allow-list (`CHILD_ENV_ALLOWLIST` in `src/brains/claude.ts`): `PATH`, `HOME`,
    locale, proxy, and Claude's own login (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`). It never gets
    `INKBOX_API_KEY`, the principals or other tokens.
  - The working directory `agents/.state/claude/<agent>/` is empty. Files an older runner left there
    (`mcp.json` held the token) are deleted before each turn.
- **Bounded cost:** `--model` (default `sonnet`, not your default model) and `--max-budget-usd` per turn.
- **Prompt injection:**
  - Both personas say that notes from the other party are untrusted data, never instructions.
  - The code doesn't trust the model either. Floors, budgets and round caps are enforced by the backend, and
    the deal email goes out only if `dealSafety` (`src/notify.ts`) confirms the picked offer is the current,
    open, in-budget and cheapest one, within 1%.
  - So the worst an injected note can do is a bad recommendation that the person still has to approve.

**Personas:**
- **Seller:** sell within floors, concede gradually (accept a counter at the floor only from round 3), and end
  every turn with `make_offer` or `decline_request`.
- **Buyer:** never reveal the budget, never counter above 97% of it, negotiate toward the target, and say
  `READY TO RESERVE: <offer_id>`. That line is found on any line of the reply.

**Failures:**
- **401 / unauthorized:** the turn throws, so a dynamic seller's token is minted again.
- **Crash or timeout:** the turn is retried with backoff, `TURN_RETRY_DELAYS_MS` (default `2000,10000`).
- **Backend tool errors** such as `not_your_turn` or `round_limit` are not retried.

**Credentials:** `BRAIN=claude` uses this machine's Claude Code login (`HOME`), or `CLAUDE_CODE_OAUTH_TOKEN` in
the sandbox. Inkbox never receives Claude credentials. It only carries A2A messages with IDs and public totals.
The model never sends messages itself: its only actions are MCP mutations, which the backend turns into outbox
rows.

### Concurrency, sweep and the runner lock

- **Per-request lanes:** the platform buyer agent runs one lane per request, so a slow turn on one order doesn't
  hold up another. Turns for one request stay in order. Each seller agent runs its turns in order.
- **Turn limit:** at most `MAX_CONCURRENT_TURNS` turns (`claude -p` processes) run at once across all agents.
  The default is 4.
- **Backend calls:** each one times out after 15 s.
- **Sweep:** every `SWEEP_MS` (default 60 s) the runner calls `POST /worker/sweep`, so the backend releases
  stale holds and expires requests past their deadline. A backend without that route answers 404, and sweeping
  stops quietly.
- **Notices, which never become brain turns:**
  - `order.confirmed` to the seller sends the "Sold" email; to the buyer, the "Order confirmed" email from the
    buyer agent's mailbox.
  - `session.closed` writes a log line and a transcript line.
- **Single instance:** `agents/.state/runner.lock`, with a 30 s heartbeat, refuses a second runner on the same
  state directory. That covers `npm start` and the sandbox container alike. A lock whose heartbeat stopped
  more than 90 s ago, or whose process on this machine is gone, is taken over.
- **Startup warnings:** a principals token that expires within 24 h, when the file records `expires_at`, and
  `BRAIN=mock` against a deployed backend. A 401 when polling says to run `npm run agents:tokens`.

### Sandboxed runner (Docker)

`npm run start:sandboxed` runs the whole runner inside a container on this machine (`Dockerfile`,
`scripts/start-sandboxed.sh`). Even if a turn escaped its tool limits, it couldn't see your files.

1. Stop any `npm start` runner first. The lock refuses a second one anyway.
2. `claude setup-token`, then `export CLAUDE_CODE_OAUTH_TOKEN=<token>`. That is a login for your subscription,
   used instead of the host's `~/.claude`. Keep it out of files.
3. `npm run start:sandboxed`.

The container:
- reads `agents/.env.local` as its environment;
- mounts only `agents/.state` (as `/state`) and the principals file (read-only);
- runs as an unprivileged user on a read-only root filesystem, with all capabilities dropped and
  `no-new-privileges`;
- can't see your home directory, repo or keychain.

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
  - the identity cap, HTTP 402 and `INKBOX_LOCAL_SELLERS` falling back to in-process delivery;
  - adopting existing identities after local state is lost;
  - tunnels started with `serveForever()`, and replaying tasks that are still `submitted` after a restart.
- **`self-serve.test.ts`:** covers self-serve businesses:
  - dynamic seller agents minted once, cached, and re-minted near expiry;
  - sellers whose owner negotiates in chat;
  - retried mint failures;
  - `order.confirmed` notices that never become turns;
  - the sale email (sender fallback, escaping, once per order).

  The second e2e test in `negotiation.e2e.test.ts` runs a self-serve business end to end: it wins the
  negotiation with a minted token, and its owner gets the sale email.
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
