# Agent conversation visibility

The goal is to show how the agents talked, in two places:
- **In Claude:** a chat timeline in the buyer's order panel and in the seller's negotiation panel.
- **On a live web page:** the buyer projects it on a big screen while the agents haggle.

Each turn shows:
- who moved: the buyer's agent, the buyer in chat, a seller's agent, or the seller in chat;
- the price and the note that agent wrote;
- when it happened;
- the Inkbox A2A hop that carried the notification (from-identity → to-identity, message ID, context ID).

## Database: `migrations/20261018000700_conversation.sql`

Additive only.

- **`commerce_outbox`** gains `delivery jsonb`. It is NULL until the runner reports a delivery.
- **`commerce_ack_event(p_event uuid, p_delivery jsonb DEFAULT NULL)`** (re-create, keeping the current
  behavior, including `order.confirmed.seller`) stores `p_delivery` when the delivery is a JSON object.
  - **Allowed keys:** `transport` (`inkbox` or `local`), `from_handle`, `to_handle`, `message_id`, `context_id`,
    `delivered_at`.
  - **Validation:** strings only, at most 200 characters each. Other keys are dropped, and invalid input raises
    `invalid_input`.
  - **No delivery:** acking without `p_delivery` stays valid; the row is acked with no delivery.
- **`commerce_conversation(p_request uuid)`** returns jsonb with:
  - top level: `{request_id, title, status, delegate_negotiation, sessions: [...]}`, sessions ordered by seller name
  - each session: `{session_id, seller_id, seller_name, status, turn, rounds, seller_agent: boolean, seller_handle, opened_at, messages: [...]}`
    (`seller_agent` is the seller's `delegate_negotiation`; `seller_handle` is its `agent_handle`)
  - each message: `{kind, by, total_cents?, note?, reason?, version?, offer_id?, counter_id?, at, delivery?}`
  - **`kind`:** `opened` | `offer` | `counter` | `declined`
  - **`by`:** `buyer` | `seller` | `platform` (`opened` is by `platform`)
  - **`delivery`:** the outbox delivery JSON for the event that announced this message, matched by
    `aggregate_id`. For `session.opened` the outbox aggregate is the session ID, so check the existing
    `INSERT`s and match whatever they use.
  - **Order:** messages are in chronological order.
  - **Privacy:** it never includes floors, budgets, targets, line items or buyer email.
  - **Access:** SECURITY INVOKER, `project_admin` only. The backend checks access first.

## Backend routes

| Route | Who | Behavior |
|---|---|---|
| `GET /api/v1/buy-requests/:id/conversation` (role or connector token, negotiation handler) | `buyer`: own request. `buyer_agent`: a delegated request. | `commerce_conversation` |
| The same path on the **user-session** path (`server.ts`, InsForge session) | The buyer who owns the request | Same JSON, for the web live page |
| `GET /api/v1/seller/sessions/:id/conversation` | `seller`: own session only | The one session in the same message shape, with the seller's own `note`s. No other sellers. |
| `POST /api/v1/worker/events/:id/ack` | worker | Now accepts an optional JSON body `{delivery:{...}}` and passes it as `p_delivery`. An empty body works as today. |

## MCP (`mcp/`)

- **New tool `get_conversation` (buyer):** `{request_id}` → the conversation. It renders the new **conversation**
  view: one thread per seller, chat bubbles alternating sides, a price chip, the note, a relative time and a
  small "Inkbox A2A · exchangent-x → exchangent-buyer" line. Message wording:
  - `by=buyer`: "Your agent" when the request is delegated, otherwise "You".
  - `by=seller`: "<seller> agent" when `seller_agent`, otherwise "<seller>".
- **Lowest current offer:** shown at the top of the view.
- **Live page link:** an "Open live view" link to `${EXCHANGENT_WEB_URL}/watch/<request_id>`.
  `EXCHANGENT_WEB_URL` defaults to `https://web-five-jet-34.vercel.app`.
- **`get_buy_order` result:** gains `watch_url` (that same URL), and its `next` hint mentions `get_conversation`.
- **Seller `get_negotiation` view:** its activity list uses the same bubble style.
- **Refresh:** if the MCP Apps bridge lets a view call a tool, the view refreshes every 3 s while any session
  is open. Otherwise it gets a Refresh button.

## Web (`web/`)

- **`/watch/[requestId]`:**
  - **Before load:** a signed-in buyer page. Signed out, it shows the sign-in form, then returns to the page.
  - **Data:** polls `/api/commerce/buy-requests/<id>/conversation` every 1.5 s while the request is
    negotiating, and every 10 s afterwards.
  - **Layout:** a light workspace with a seller comparison, one filterable activity feed, and a compact outcome/progress panel.
    - Each activity entry shows who moved, the price and a short note. Delivery details (including Inkbox hops) expand on demand.
    - A header shows the request title, status, the best offer so far and the elapsed time.
    - When the buyer agent is ready, a "Deal reached" banner appears.
  - **Design:** light by default, using the existing typography and restrained neutral workspace styling.
- **Proxy allowlist:** the commerce proxy allowlist gains `buy-requests/<id>/conversation`.
- **Dashboard:** each request in the dashboard links to "Watch agents".

## Agents (`agents/`)

- **Delivery receipts:** `Transport.send` returns a receipt
  `{transport, from_handle, to_handle, message_id, context_id, delivered_at}`.
  - Inkbox: the identities' handles, the event ID, and the A2A context.
  - Local: `transport:'local'` with agent slugs.
- **Acks carry the receipt:** the dispatcher acks with `{delivery: receipt}`. Skipped and backlog acks send no
  delivery.
- **Readable transcript:** the runner prints one log line per turn, for the terminal:
  `💬 Alex Woodworks agent → Buyer agent: $300.00 "Deal at $300." [inkbox exchangent-alex-woodworks → exchangent-buyer]`

## Web dashboard (`web/`)

The web app is the human home base. The live page and the dashboard both live here. Today's `components/dashboard.tsx` is a thin buyer
workspace; rebuild it into a real signed-in dashboard (sign-in with the same email-code form when signed out):

- **Buying:** my requests (title, status, best current offer, number of sellers, agent on/off), each with "Watch agents"
  (`/watch/<id>`) and a detail view (offers, the reserve → checkout flow the dashboard already has, receipt when confirmed).
- **Selling:** my businesses (from a new user-session route `GET /api/v1/businesses` → the actor's businesses as business JSON) with
  inventory (list price, private floor, available, sold), agent on/off, and live negotiations for that business
  (`GET /api/v1/businesses/:id/sessions` user-session, owner only → the seller's sessions incl. conversation messages for that
  business only). Creating a business and adding inventory from the web is a plus: `POST /api/v1/businesses` exists;
  add user-session `POST /api/v1/businesses/:id/inventory` and `PATCH /api/v1/businesses/:id` (owner only, same validation as the
  seller routes).
- **Connect your assistant:** the MCP URL `https://fast-cloud-tpp4j.run.mcp-use.com/mcp` with copy button and short steps for
  Claude (claude.ai → Settings → Connectors → Add custom connector) and Claude Code (`claude mcp add --transport http exchangent <url>`).
- Visual quality: this is shown at a YC demo. Clean, confident, responsive; reuse the existing brand/tokens (globals.css, oauth.css).
- Proxy allowlist (`app/api/commerce/[...path]/route.ts`) gains exactly the new paths.
