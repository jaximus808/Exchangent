# Demo runbook: agents negotiating over Inkbox

The story: you tell Claude what you want. Your buyer agent and the sellers' agents haggle with each other over
Inkbox A2A until they agree. Exchangent's database is the rulebook every agent obeys. The buyer agent emails
you from its Inkbox mailbox when it has a deal. You reserve and pay in Claude, and the seller's agent emails its owner when the order is paid.

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
   - Emails come from the agents' Inkbox mailboxes: the deal email (buyer agent) and the sale email (seller agent). The
     Primitive receipt is optional and stays off unless `PRIMITIVE_API_KEY` and `PRIMITIVE_FROM` are set.

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
6. **Buyer:** "is it paid?" The order is confirmed.
7. **Seller's inbox:** "Sold: …, $300.00" from their own agent. **Seller, in Claude:** "show my inventory".
   The stock went down by one of each.

## More scenarios

The buyer is on **claude.ai** with the Exchangent connector, signed in as the buyer email. The seller is in **Claude Code**,
connected as Alex Woodworks. Use fresh wording each run: an identical order returns the earlier request.

### Scenario 2: desk-only bidding war (four sellers)

Four businesses stock a desk of 48in or less. Their delivered minimums are private, but ranked from lowest:
Exchangent Seller Test (1 left), Alex Woodworks, Bay Desk Co, Mission Ergonomics. The point is that the cheapest seller
wins, and Alex's agent never goes below its floor.

1. **Seller (Claude Code):**
   > Show my inventory. Make sure the walnut desk has at least 2 available.
2. **Buyer (claude.ai):**
   > I just need a desk, no chair: 48 inches wide or less, delivered in San Francisco by tomorrow. My budget is $220
   > all-in and I'd like to pay around $160. Let my agent negotiate.
3. **Buyer:**
   > Show me how the agents are negotiating.

   Open "Watch the agents negotiate live ↗" on the big screen. Every seller agent opens at list: $200, $255, $285 and
   $320. Each one is countered at about $160, and they concede at different speeds.
4. **Expected result:** the deal email comes from the cheapest seller that reaches the buyer agent's number. Usually
   that's Exchangent Seller Test (about $160) or Alex Woodworks ($170 is Alex's floor). Bay and Mission stall above $200.
   - **Say:** "Alex's agent stopped exactly at the owner's private minimum. It can't go lower, because the backend
     refuses any offer below the floor."
5. **Buyer:**
   > Show my offers, then reserve the best one and get me a checkout link.

   Pay with `4242 4242 4242 4242`. Then:
   > Is my order paid?
6. **Seller (only if Alex won):**
   > Show my inventory and recent negotiations.

### Scenario 3: the owner haggles by hand, and the buyer agent switches to the better deal

This scenario shows a person in the loop. The seller turns its agent off and negotiates in chat. The buyer's agent
still haggles for the buyer, and when a cheaper offer arrives late it reopens the deal.

1. **Seller (Claude Code):**
   > Turn off agent negotiation for my business.
2. **Buyer (claude.ai):**
   > Get me a compact desk under 48 inches and an ergonomic office chair delivered in SF. $400 max, hoping for about
   > $300. Let my agent negotiate.

   The runner log shows `skipped … seller negotiates in chat` for Alex Woodworks. Bay and Mission haggle with the buyer
   agent, which settles on Bay at about $370. The buyer gets the deal email.
3. **Seller:**
   > Show my open buyer requests.

   Then:
   > On that request, offer my walnut desk and mesh chair at $310 total including delivery, with the note "Hand-made
   > walnut, delivered tomorrow."
4. **Watch:** the buyer agent sees a cheaper late offer and counters Alex at $300.
5. **Seller:**
   > Read that negotiation again and accept the buyer's counter.
6. **Expected result:** the buyer agent switches to Alex Woodworks, and the buyer gets a **"Better deal: Alex
   Woodworks, $300.00"** email.
7. **Buyer:**
   > Show my offers and reserve the Alex Woodworks offer.

   Pay with `4242 4242 4242 4242`, and the seller gets the "Sold" email.
8. **Seller, afterwards:**
   > Turn agent negotiation back on.

Measured cost with `BRAIN=claude`: about $0.20 per agent turn, so about $3 for a three-seller haggle.

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
