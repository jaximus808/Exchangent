# Demo runbook: agents negotiating over Inkbox

The story: you tell Claude what you want. Your buyer agent and the sellers' agents haggle with each other over
Inkbox A2A until they agree. Exchangent's database is the rulebook every agent obeys. The buyer agent emails
you from its Inkbox mailbox when it has a deal. You reserve and pay in Claude, and Primitive emails the receipt.

## How the agents communicate

```
 seller agent ──make_offer (MCP)──▶ backend ──▶ Postgres: offer row + outbox row "offer.created"
                                                         │
                                  runner polls outbox ◀──┘
                                         │
       Inkbox A2A message  exchangent-bay-desk-co ──▶ exchangent-buyer
       (one A2A context per negotiation session; data part = kind + IDs + public total; text part = short note)
                                         │
 buyer agent ◀── tunnel webhook (signed) ┘
     │
     └─ get_buy_order (MCP) ──▶ reads the offer from the database, then counter_offer (MCP) ──▶ ...and back again
```

- **The message is the notification, and the database is the governing layer.** An agent acts only through
  MCP tools. The backend enforces whose turn it is, the version (`expected_version`), price floors, stock and
  the budget, then writes the offer and an outbox row in one transaction.
- **Inkbox carries the "you've got a new offer" message** from the sender's identity to the recipient's
  identity, with one A2A context (thread) per session.
- **The recipient never trusts numbers in the message.** Every turn starts by re-reading the session or order
  over MCP. A tampered or replayed message can't move money or break a rule (the e2e test tampers with totals
  on purpose).
- **`TRANSPORT=local`** is the same flow with the Inkbox hop replaced by an in-process queue.

## Cast

| Inkbox identity | Who | Token (`backend/.agent-principals.json`) |
|---|---|---|
| `exchangent-buyer` | **Platform buyer agent.** It negotiates every order whose buyer left "let my agent negotiate" on (`delegate_negotiation`, default true), for any account. It can read and counter only. It can never create, reserve or pay. | `buyer_agent` |
| `exchangent-bay-desk-co` | Bay Desk Co's sales agent. It can reach $345 at its floors. | `seller` |
| `exchangent-mission-ergonomics` | Mission Ergonomics' sales agent. Its floors add up to $425, so it can't win under $400. | `seller` |

SoMa Office Supply only has desks wider than 48in. It never gets a session, so the demo needs 3 identities
(the Inkbox free plan cap).

## One-time setup (live)

1. **Apply migrations** to InsForge, from the repo root:
   ```bash
   npx -y @insforge/cli db migrations up --all    # 20261018000300 order email, 0400 buyer agent, 0500 stale holds
   ```
2. **Deploy the backend** (merge to `main`, which deploys Vercel) so production has the `buyer_agent` routes.
3. **Mint agent tokens.** This is additive: it never resets stock and never touches your teammate's seed tokens.
   ```bash
   cd backend && npm run agents:tokens     # writes backend/.agent-principals.json (72h tokens)
   ```
   `backend/.env.local` needs `INSFORGE_URL`, `INSFORGE_API_KEY` and `COMMERCE_BASE_URL=https://exchangent.vercel.app`.
4. **Configure the runner.** `agents/.env.local` sets `TRANSPORT=inkbox`, `BACKEND_URL=https://exchangent.vercel.app`,
   `MCP_URL=https://warm-pulse-8qbp6.run.mcp-use.com/mcp` (the bearer-mode server),
   `PRINCIPALS_FILE=../backend/.agent-principals.json`, `SKIP_BACKLOG=1` (ignore old test traffic) and your
   admin-scoped `INKBOX_API_KEY`.
5. **Smoke test Inkbox:** `cd agents && npm run inkbox:smoke`. It creates the three identities and sends one
   A2A round trip. Don't run it while the runner is up: two processes on one tunnel take it over from each
   other.
6. **Start the runner:** `cd agents && npm start` (`BRAIN=mock` to rehearse, `BRAIN=claude` for the show).
7. **Connect Claude:** add the `exchangent-mcp-oauth` connector (`https://fast-cloud-tpp4j.run.mcp-use.com/mcp`),
   sign in, and choose **Buyer account**.
8. **Payments:**
   - The Stripe sandbox needs a webhook endpoint `https://exchangent.vercel.app/webhooks/stripe` whose signing
     secret is `STRIPE_WEBHOOK_SECRET` on Vercel.
   - The receipt email needs `PRIMITIVE_API_KEY` and `PRIMITIVE_FROM` on Vercel (see `backend/SETUP.md`).

## Live script (about 3 minutes)

1. **Ask in Claude:** "Find me a desk no wider than 48 inches and an ergonomic chair delivered in San
   Francisco by tomorrow. My budget is $400 all-in, and I'd love $300." Claude calls `create_buy_order` and the
   order panel opens.
   - Say: "Claude doesn't haggle. It hands off to my buyer agent."
   - Identical orders are idempotent and return the earlier request. If you rehearsed with the same wording,
     change a word.
2. **Show the runner terminal** (and the Inkbox console, if there's room on screen):
   - `exchangent-buyer` opens sessions with both sellers.
   - The sellers open at list price ($465 and $530).
   - The buyer agent counters at $300.
   - The sellers concede about 5%.
   - The buyer agent splits the difference ($371.50).
   - Bay Desk Co meets it.
   - The run ends with `READY TO RESERVE` and `deal email sent`.
   - Say: "Every line is an A2A message between two agents' Inkbox identities. None of them carries authority.
     Each agent re-reads the deal from Exchangent before it moves."
3. **Show your inbox:** "Deal reached: Bay Desk Co, $371.50", from the buyer agent's own Inkbox mailbox.
4. **Ask in Claude:** "show my offers". The panel shows Bay Desk Co at $371.50 against Mission at about $478.
5. **Ask in Claude:** "reserve the Bay Desk Co offer and get me a checkout link". This holds the stock and opens
   Stripe test Checkout. Pay with `4242 4242 4242 4242`.
6. **Ask in Claude:** "is it paid?" `get_reservation_status` shows the order confirmed, and Primitive's receipt
   arrives in your inbox.
   - Say: "Agents negotiated. A human approved the payment. The rules lived in one place."

Measured locally: with `BRAIN=claude` the haggle took about 75 seconds, at roughly $0.15–0.18 per turn on the
default model. `CLAUDE_MODEL=haiku` is cheaper.

## Rehearse locally (no keys, no InsForge, fake Stripe)

```bash
# Postgres with every migration (see backend/test/sql/run.sh for the loop), then:
cd backend
DATABASE_URL=postgres://... npm run seed:negotiation
DATABASE_URL=postgres://... COMMERCE_BASE_URL=http://127.0.0.1:8787 npm run agents:tokens
DATABASE_URL=postgres://... npm run local:server      # opening a checkout URL "pays" via a signed local webhook
cd ../mcp && EXCHANGENT_AUTH=bearer EXCHANGENT_API_URL=http://127.0.0.1:8787/api/v1 npm run dev
cd ../agents && TRANSPORT=local BRAIN=mock MCP_URL=http://127.0.0.1:3100/mcp npm start
BUYER_TOKEN=<a buyer token> node scripts/buyer.ts create   # then reserve <offer_id>, checkout <reservation_id>
```

## If something goes wrong

- **`IdentityCapError`:** a fourth identity was requested. Check that only Bay Desk Co and Mission matched, or
  raise the plan cap.
- **"order not delegated to the buyer agent":** the order was created with `delegate_negotiation: false`, so
  the person negotiates it in chat.
- **`401` from the backend in the runner:** the agent tokens expired (72 hours) or were rotated. Run
  `npm run agents:tokens` again and restart the runner.
- **A reservation is stuck in `awaiting_payment`:** a hold that never opened checkout is released on the next
  reserve, at most about 2 minutes after it was made.
