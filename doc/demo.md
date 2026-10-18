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

Two different people, each in their own Claude with the Exchangent connector
(`https://fast-cloud-tpp4j.run.mcp-use.com/mcp`). Nobody is seeded: any email signs in with a code, and a new
email creates the account.

| Who | Signs in as | Their agent | Inkbox identity |
|---|---|---|---|
| **Seller** (person A, any email) | **Create a business** on the consent screen, then stocks it in chat | Platform seller agent, minted for the business while "let my agent negotiate" is on | `exchangent-<business-slug>` |
| **Buyer** (person B, a different email) | **Buyer account** | Platform buyer agent (`buyer_agent` token) | `exchangent-buyer` |
| Competitor (optional) | nobody: seeded Bay Desk Co | Seeded seller agent | `exchangent-bay-desk-co` |

- Mission Ergonomics and SoMa Office Supply still compete, but they use in-process delivery
  (`INKBOX_LOCAL_SELLERS`).
- **The free Inkbox plan has 3 identities: buyer, the new business, and Bay.** If all 3 are already taken, the
  new business falls back to in-process delivery: it still negotiates, but its messages don't go over Inkbox.
  Free a slot first by deleting an unused identity (for example `exchangent-mission-ergonomics`) in the Inkbox
  console.
- The seller can turn the agent off (`update_business` with `agent_negotiates:false`) and haggle by hand with
  `list_my_requests`, `get_negotiation` and `make_offer`. The buyer agent still answers. A late, cheaper offer
  reopens the haggle, and the buyer then gets a "Better deal" email.

## One-time setup (live)

1. **Apply migrations** from the repo root:
   ```bash
   npx -y @insforge/cli db migrations up --all    # through 20261018000600 self-serve sign-up
   ```
2. **Deploy:**
   - Merge to `main` (Vercel deploys the backend and the web consent page).
   - The Manufact MCP servers redeploy from `manufact`.
3. **Mint agent tokens** (`cd backend && npm run agents:tokens`): the worker, the buyer agent and the seeded
   sellers. Self-serve businesses need nothing here: the runner mints their seller tokens itself.
4. **Runner settings:** `agents/.env.local` sets:
   - `TRANSPORT=inkbox`, `BACKEND_URL=https://exchangent.vercel.app`
   - `MCP_URL=https://warm-pulse-8qbp6.run.mcp-use.com/mcp`, `PRINCIPALS_FILE=../backend/.agent-principals.json`
   - `SKIP_BACKLOG=1`, `INKBOX_LOCAL_SELLERS=Mission Ergonomics,SoMa Office Supply`
   - an admin-scoped `INKBOX_API_KEY`
5. **Smoke test:** `cd agents && npm run inkbox:smoke`. Then `npm start` (`BRAIN=mock` to rehearse,
   `BRAIN=claude` for the show).
6. **Payments:**
   - Stripe sandbox webhook `https://exchangent.vercel.app/webhooks/stripe`, with `STRIPE_WEBHOOK_SECRET` on Vercel.
   - The Primitive receipt needs `PRIMITIVE_API_KEY` and `PRIMITIVE_FROM` (see `backend/SETUP.md`).

## Live script (about 4 minutes)

1. **Seller signs up.** Person A connects Exchangent, enters their email and the code, picks **Create a
   business** ("Alex Woodworks", $15 delivery, 1 day) and approves. In chat:
   > Add a walnut writing desk, 46 inches wide, list $240, my minimum $155, 2 in stock. And a mesh ergonomic
   > chair, list $210, minimum $130, 3 in stock.

   Claude calls `upsert_inventory_item` twice. Say: "The floor is private. The buyer's side never sees it."
2. **Buyer signs up.** Person B connects with a different email, picks **Buyer account**, and asks:
   > Find me a desk no wider than 48 inches and an ergonomic chair delivered in San Francisco by tomorrow.
   > Budget $400 all-in, I'd love $300.
3. **Show the runner terminal.**
   - The buyer agent opens sessions with Alex Woodworks, Bay Desk Co and Mission.
   - Each seller agent opens at list price.
   - The buyer agent counters at $300, and Alex's agent meets it (its floors add up to $300).
   - The buyer gets `READY TO RESERVE` and a deal email.
   - Say: "Two people's agents haggled over Inkbox A2A. Each one re-reads the deal from Exchangent before it
     moves."
4. **Buyer's inbox:** "Deal reached: Alex Woodworks, $300.00".
5. **Buyer, in Claude:** "reserve the Alex Woodworks offer and get me a checkout link". Pay with
   `4242 4242 4242 4242`.
6. **Buyer:** "is it paid?" The order is confirmed and the receipt arrives.
7. **Seller's inbox:** "Sold: …, $300.00" from their own agent. **Seller, in Claude:** "show my inventory".
   The stock went down by one of each.

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
