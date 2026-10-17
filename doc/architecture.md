# Agent Commerce: Architecture

*YC Make Something Agents Want hackathon, October 17–18, 2026*

## What we're building

This is a marketplace where a buyer's AI assistant places one request and seller agents compete to fill it. The buyer describes what they need once. Seller agents make offers and negotiate within rules their owners set. The buyer approves the final purchase, which runs through Stripe Checkout.

**Demo:** "Find a desk and ergonomic chair under $400 total, delivered in San Francisco this weekend; desk no wider than 48 inches." Three demo sellers compete on price, delivery and bundles. The buyer gets an email with the winning offer and a Stripe link. Paying confirms the order.

## How the pieces fit

```
 Buyer's Claude/ChatGPT                       Seller owner (human)
          │ MCP (OAuth)                              │ email
          ▼                                          ▼
 ┌──────────────────────────────┐          ┌──────────────────────┐
 │ MCP server (mcp-use, hosted  │          │ Primitive            │
 │ on Manufact): thin layer     │          │ email to/from humans │
 └──────────────┬───────────────┘          └──────────┬───────────┘
                │ HTTPS                               │
 ┌──────────────▼─────────────────────────────────────▼───────────┐
 │ Next.js on Vercel: API, dashboard, Stripe webhook              │
 │ business rules: price floors, budgets, holds, idempotency      │
 └──────────────┬─────────────────────────────────────────────────┘
                │
        InsForge (database + auth)
                ▲
 ┌──────────────┴───────────────────────────────────┐
 │ Agent worker (always running): Railway, Fly or   │
 │ Blaxel                                           │
 │ buyer agent (one per order) and seller agents    │
 │ A, B, C; each has its own inbox and handles one  │
 │ event at a time                                  │
 └──────────────┬───────────────────────────────────┘
                │ A2A (structured offers + notes)
             Inkbox (each agent's identity, A2A conversation log, tunnel)
```

| Component | Service | What it does |
|---|---|---|
| MCP server | mcp-use, hosted on Manufact | Tools for the buyer's and seller's assistants. Passes calls to our API and holds no state. |
| API, dashboard, webhooks | Next.js on Vercel | The only place business rules live. Receives Stripe webhooks. Runs the live dashboard. |
| Database and auth | InsForge | Orders, offers, sessions, inventory, seller rules, agent notebooks, user accounts |
| Agent runtime | Always-running worker process | Runs the buyer and seller agents |
| Agent-to-agent messaging | Inkbox A2A | Negotiation messages: a JSON offer reference plus a written note |
| Human email | Primitive | Buyer confirmations, seller-owner approvals, owner instructions to their agent |
| Payments | Stripe Checkout (test mode) | Paying confirms the purchase |
| Analytics | Armature | Agent analytics |

## Decisions we've made

### 1. The MCP server calls our API, not the database
An mcp-use server is ordinary TypeScript, so it could connect to the database directly. But the dashboard, the Stripe webhook and the agents all need the same rules: floors and budgets stay hidden, offers must meet the floor, holds expire, and repeated calls never create duplicate orders. Those rules live in one place, our API. The MCP server only turns tool calls into API requests.

### 2. We still need a web server
An MCP server only runs when an assistant calls a tool. We also need:
- Stripe webhook endpoints
- A live dashboard for the judges
- Sign-in, store connection and seller rule setup for humans
- Something that wakes the agents when no chat is open

Vercel handles everything except the agents. The agents run in the worker.

### 3. Agents run in one always-running worker
- Each agent is a loop with its own inbox and handles one event at a time. Without that rule, two orders can be promised the same last desk.
- **An agent's memory lives in the database, not in the process.** That covers its order threads and a notebook such as "desk demand is high this weekend." If the worker restarts mid-demo, the agent rebuilds its context and carries on.
- One seller agent sees all of its orders, so it can adjust: three buyers want the last desk, so it stops discounting.
- For the demo, one worker process runs every agent. Give each seller its own VM later, once agents run seller-supplied code or browse real storefronts.

### 4. Inkbox handles agent-to-agent messages, Primitive handles humans
- **Inkbox A2A** is used for the negotiation. It's the standard Google/open A2A 1.0 protocol (JSON-RPC), hosted by Inkbox. Messages can carry structured JSON parts alongside text. A negotiation is one conversation (`contextId`), and Inkbox keeps the log.
- **Primitive** is used for email with people: the buyer's confirmation, approval requests to shop owners, and owners emailing their agent ("stop discounting chairs").

## The negotiation protocol

### Rule: the database holds the numbers, messages carry the reasons
An agent never writes to the database directly and never sends a message directly. It calls `make_offer`. Our code checks the offer, saves it, and then sends the A2A message as a side effect. The receiving agent always loads the offer from the database, never from the message text.

**Agent tools:** `make_offer`, `accept_offer`, `decline`. The written note is the only free-form part.

### One round

```
Seller agent B              our code                     Inkbox             Buyer agent
  make_offer($370, note) ─► check floor, stale reply,
                            leaked numbers
                            INSERT offer v3 (DB)
                            a2a.send(contextId,
                              parts: [{data:{offer_id, version, …}},
                                      {text: note}])
                                                   ─────► log + webhook ──► tunnel ─► check signature,
                                                                                      skip duplicate event id
                                                                                      load offer v3 from DB
                                                                                      push into buyer's inbox
                                                                                      next turn: "Seller B
                                                                                      countered $370: '…'"
                                                                                      → make_offer / accept_offer
```

### `make_offer` (the middleware)

```ts
async function makeOffer(agent, { session_id, responding_to, price, items, note }) {
  const s = await db.sessions.get(session_id);
  if (responding_to !== s.latest_offer_id)
    return { status: "stale", latest_offer_id: s.latest_offer_id, next: "read the latest offer, then respond to it" };
  if (agent.role === "seller" && price < floor(agent, items))
    return { status: "rejected", reason: "below your minimum price", next: "offer at or above your minimum" };
  if (agent.role === "buyer" && price > budget(session_id))
    return { status: "rejected", reason: "over the buyer's budget", next: "counter lower or decline" };
  if (leaksPrivateNumber(note, agent))
    return { status: "rejected", reason: "note reveals a private limit", next: "rewrite the note without it" };

  const offer = await db.offers.insert({ session_id, price, items, note, version: s.version + 1 }); // version check
  await outbox.enqueue(offer.id);  // sender: a2a.send(..., messageId: offer.id), retried until it succeeds
  return { status: "sent", offer_id: offer.id, next: "wait for their response" };
}
```

What this guarantees:
- **The message and the database always match.** The agent can't announce $350 while saving $370, and it can't forget to save.
- **Retries are safe.** The offer ID is also the A2A `messageId`, which Inkbox treats as an idempotency key, so a retry never sends twice.
- **Out-of-date replies are caught.** If both sides counter at the same moment, the later reply to an old offer is rejected and told to read the latest one.
- **Private numbers stay private.** Floors and budgets are checked in code. The buyer agent's prompt gets a target price, not the real budget. Notes that contain the budget or floor numbers are blocked.

### How the message gets sent (the outbox sender)
The model decides what to offer, and our code sends the message through Inkbox. The message goes out from the agent's own Inkbox identity, using that agent's own key:

```ts
// runs in the worker; retried until it succeeds
async function deliver(offerId) {
  const offer = await db.offers.get(offerId);
  const s = await db.sessions.get(offer.session_id);
  const a2a = await identities[offer.from_agent].a2aClient();      // the sending agent's Inkbox identity
  const target = await a2a.fetchCard(`https://inkbox.ai/a2a/${s.counterparty_handle}/card`); // cache this

  await a2a.send(target, {
    contextId: s.inkbox_context_id,          // omit on the first message; save the one Inkbox returns
    messageId: offer.id,                     // idempotency: a retry can't send twice
    parts: [
      { data: { type: "offer", offer_id: offer.id, version: offer.version, price: offer.price, items: offer.items } },
      { text: offer.note },                  // the agent's written note
    ],
  });
  await db.offers.update(offerId, { delivered_at: new Date() });
}
```

The full path: the model calls `make_offer` → our code checks the offer and saves it → our code calls Inkbox `a2a.send` as that agent → Inkbox fires a webhook to the other agent → the other agent reads the offer from the database. Both agents belong to our Inkbox organization, so no contact rules are needed between them.

### How an agent receives a message mid-session
A model is never interrupted mid-generation. The worker receives the message and gives it to the model as its next turn.

```ts
import { connect } from "@inkbox/sdk/tunnels/connect";

await connect(inkbox, {
  name: identity.agentHandle,
  handler: async (req) => {
    const raw = await req.text();
    verifyWebhook({ payload: raw, headers: req.headers, secret: WHSEC }); // HMAC check, 300s window
    const evt = JSON.parse(raw);
    if (await alreadySeen(evt.id)) return new Response("ok");  // delivery is at-least-once
    inbox(agentId).push(evt);
    return new Response("ok");                                  // respond fast; replying here sends nothing
  },
});
```

```ts
while (true) {
  const evt = await inbox.next();                              // waits until something arrives
  const ref = evt.data.parts.find(p => p.data)?.data;
  const offer = await db.offers.get(ref.offer_id);             // the DB has the real numbers
  history.push({ role: "user", content: describe(evt, offer) });
  await runTurn(history, tools, {
    // after every tool call: if new events are waiting, add them before the next model step
    onToolResult: () => drainInbox().forEach(e => history.push(describeNew(e))),
  });
}
```

The `onToolResult` hook is how an agent updates its thinking as it goes. If buyer B's order arrives while the agent is writing an offer to buyer A, the agent sees it before its next step.

### Replying
On the network, a reply is another A2A send in the same conversation. Either side can start a new task in a shared `contextId`, so buyers and sellers use the same code. To confirm receipt, the agent marks the incoming task complete:

```ts
await identity.a2aReply(task.id, { intent: "complete", text: "received" });
```

## Closing the sale: the buyer confirms by email

The confirmation email contains a Stripe Checkout link, and paying is the confirmation. We never trust a reply that only says "yes," because email senders can be faked.

```
negotiation ends ─► buyer agent picks the best offer ─► reserve_offer (stock held 30 min)
                                                          │
                         our code (not the agent) sends via Primitive:
                         "Seller B: desk + chair, $372, delivered Sat. Why I picked it: …
                          [Pay with Stripe]  (link expires in 30 min)"
                                                          │
          ┌───────────────────────────┬───────────────────┴──────────────────────┐
     buyer pays                  buyer replies with text               buyer ignores it
          │                           │                                         │
  Stripe webhook               Primitive inbound ─► buyer agent's inbox     hold expires
  → order confirmed            "can you get it under $360?"                 → stock released
  → confirmation email         → agent resumes negotiating over A2A         → "Offer expired, want me
    in the same thread         → replies in the same email thread             to run it again?"
```

- Our code sends the email, not the agent, using the reservation ID as the idempotency key. The numbers come from the database.
- If the buyer is still in the Claude chat, the same link appears there. Whichever they use first wins, and the other becomes a no-op.
- The stock hold matches the Stripe Checkout link's expiry. Stripe links last at least 30 minutes, so the hold is 30 minutes.
- The "reply to renegotiate" path is the strongest moment in the demo: the buyer replies from their phone and the agents start negotiating again.

### Seller-owner approvals
When a deal goes beyond what the seller's agent is allowed to agree to (for example 12% off when its limit is 10%), the agent emails the owner: "Buyer wants 12% off a $410 bundle. Reply APPROVE or DECLINE." The owner already emailed the agent during onboarding, so Primitive allows the email, and we check the verified sender address. That one negotiation waits for the owner's answer while the agent keeps working on its other orders.

## Dashboard
- **Offers and order status come from our database**, which holds the real numbers.
- **Negotiation transcripts come from Inkbox:** `GET /api/v1/identities/{handle}/a2a/contexts/{id}` with an admin key.
- Fallback: Inkbox doesn't document its general API rate limits. If polling gets throttled, read the webhooks we already receive and store them ourselves.

## Service reference

### Inkbox
- **Receiving:** signed webhooks.
  - Subscribe with `inkbox.webhooks.subscriptions.create({ agentIdentityId, url, eventTypes })`.
  - Event types: `message.received` for email; `a2a.task.created`, `a2a.task.message` and `a2a.sent_task.updated` for A2A.
  - Signature: HMAC-SHA256, headers `X-Inkbox-Signature` and `X-Inkbox-Timestamp`, checked with `verifyWebhook()`.
  - Delivery is at least once, so skip duplicates by event `id`.
- **Tunnel:** every identity gets `<handle>.inkboxwire.com`. Running `connect(inkbox, { name, forwardTo | handler })` lets a local worker receive webhooks with no public URL. Needs Node 22 or later.
- **Polling fallback:** `iterUnreadEmails()` and `iterA2ATasks({ state: "submitted" })`.
- **A2A:**
  - Agent Card: `https://inkbox.ai/a2a/{handle}/card`
  - JSON-RPC endpoint: `POST https://inkbox.ai/a2a/{handle}`
  - Message IDs: `contextId` is the conversation, `taskId` is one task, `messageId` is the idempotency key.
  - Messages can carry JSON `data` parts.
  - Inkbox queues tasks while our worker is offline.
- **Reply:** `identity.a2aReply(taskId, { intent: "progress" | "ask_caller" | "complete" | "fail", text })`.
- **Email reply:** `identity.sendEmail({ ..., inReplyToMessageId })`. Supports an `Idempotency-Key` header.
- **No hook runs before sending.** Our code sends, so our code is the gatekeeper.
- **Package:** npm `@inkbox/sdk`.
- **Pricing:**
  - Free: 3 identities, A2A included.
  - Developer: $30/month, 10 identities.
- **Email limits:** 100 recipients per 24 hours per organization.

### Primitive
- **Receiving, any of:**
  - Long-polling with `client.inbox.stream()` (`GET /v1/emails?since=&wait=30`). Needs no public URL.
  - Signed webhooks (`Primitive-Signature` header, checked with `primitive.receive(req, { secret })`).
  - Primitive's hosted Functions (10-minute wall clock).
- **Message body:** not included in the streamed object. Fetch it with `GET /v1/emails/{id}`, or with `/conversation` to get turns ready for an LLM.
- **Reply:** `POST /v1/emails/{id}/reply`. Primitive handles the `In-Reply-To` and `References` headers.
- **Always send an `Idempotency-Key`.** Otherwise a second reply to the same email is silently dropped.
- **Only 3 custom headers are allowed**, so there's no structured metadata in email. That's another reason to use Inkbox A2A for negotiation.
- **Package:** npm `@primitivedotdev/sdk`.
- **Free plan:** $5/month of credit.

## Risks and things to settle early

| # | Issue | Fix |
|---|---|---|
| 1 | **Primitive only lets agents email humans who emailed them first.** The buyer's confirmation is rejected (`403 recipient_not_allowed`). | Ask the Primitive team at the event to turn on `send_to_any_domain`. Fallbacks: have the buyer email us first, or send this one email through Inkbox. |
| 2 | **Inkbox's free plan has 3 identities; we need 4** (one buyer and three sellers). | Ask the Inkbox team for credits (they're hosting), or pay $30 for Developer. |
| 3 | Inkbox's A2A endpoint needs a separate agent-scoped key per identity. | Mint the keys with an admin key during setup. |
| 4 | Not confirmed in the docs: JSON parts in `a2a.send` and `a2aReply` (seen only in SDK type definitions), message latency, webhook retry timing. | 15-minute test: two identities pass one JSON offer back and forth, and we time the round trip. |
| 5 | Agents leaking budgets or floors in free text | `make_offer` blocks notes containing private numbers. The buyer agent gets a target price, not the ceiling. |
| 6 | The worker restarts mid-demo | Agent memory is kept in the database, so agents rebuild their context on restart. |

## Hackathon tracks
- **Manufact (confirmed): "Best MCP Server for agents."** Our buyer and seller MCP servers fit it directly.
- **Inkbox (host):** A2A is the negotiation layer.
- **Primitive:** handles human email, plus reply-to-renegotiate.
- **Also used:** Stripe, InsForge, Armature, and Blaxel (optional, for the worker).
- To do: get the official track list from the event page or Discord and check each track's requirements.

## Build order
1. **Test:** Inkbox A2A between two agents, with a JSON offer and a timed round trip. This is the riskiest assumption.
2. InsForge schema: orders, sessions, offers, inventory, seller rules, notebooks.
3. The `make_offer`, `accept_offer` and `decline` tools, plus the outbox sender.
4. The agent worker loop with the inbox, tunnel handler and DB-backed memory.
5. Matcher: a new order opens a session for each eligible seller.
6. `reserve_offer`, Stripe Checkout, the Primitive confirmation email, and the Stripe webhook.
7. The MCP server on Manufact: `create_buy_order`, `get_offers`, `approve_offer`, `get_status`, `set_seller_rules`.
8. Live dashboard.
9. Seller-owner approval by email.

## Team split
- **MCP and negotiation:** MCP server, the agent tools, the worker loop, the Inkbox A2A integration
- **Backend and payments:** InsForge schema, API rules, matcher, Stripe, the Primitive emails
- **Dashboard and demo:** live offer dashboard, seed data for the three sellers, the demo script

## Sources
- Inkbox docs: https://inkbox.ai/docs/llms.txt (webhooks, A2A protocol, tasks, tunnels, pricing)
- Primitive docs: https://docs.primitive.dev/docs (receiving, sending, limits, OpenAPI spec)
- mcp-use: https://github.com/mcp-use/mcp-use
- Hackathon announcement: https://x.com/rayruizhiliao/status/2098103367302283513
