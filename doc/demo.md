# Demo runbook: autonomous negotiation, human-approved payment

Demo target: Sunday, October 18, 2026. Use Stripe test mode and fictional inventory only.
A connected human asks once; an independent worker runs buyer/seller turns through MCP, and Inkbox
carries recorded negotiation notifications. The database enforces authority, floors, stock and versions.
The human reviews the current offer and approves payment in hosted Stripe Checkout.

## Connections and ownership

| Connection | Endpoint | Credential |
|---|---|---|
| Human buyer or business owner | `https://fast-cloud-tpp4j.run.mcp-use.com/mcp` | OAuth; choose Buyer or the owned business at consent |
| Background agents | `https://warm-pulse-8qbp6.run.mcp-use.com/mcp` | Per-agent role token; do not replace this with the human OAuth endpoint |
| Commerce backend | `https://exchangent.vercel.app` | Verified user, connector, worker or role token, checked per operation |
| Human dashboard | `https://web-five-jet-34.vercel.app` | The same buyer/seller email used at connector consent |

Use two different emails for buyer and seller: self-owned businesses do not match their owner's requests.
Use an existing owned business where possible; do not create another "Alex Woodworks" each rehearsal.
Private floors belong only in the owner's account. Never project them in the buyer view, shared notes or emails.

## Before rehearsal

1. Apply all migrations through `20261018000900_resolution.sql` with the linked InsForge project:
   `npx -y @insforge/cli db migrations up --all`. Verify backend, both MCP deployments and web use the same revision.
2. Sync the current ignored `backend/.agent-principals.json` securely from the teammate running the worker.
   Never paste tokens in chat or commit them. A worker GET returning 401 means stop and resolve its credential.
   Do not rotate shared tokens or reseed during a teammate's test: rotation revokes their worker; reseeding resets stock.
3. Run exactly one independent worker, using the current code:
   ```sh
   cd agents
   BRAIN=claude TRANSPORT=inkbox SKIP_BACKLOG=0 npm start
   ```
   Configure the backend and agent MCP endpoints from the table, the principals file, and the Inkbox key in
   `agents/.env.local`. `SKIP_BACKLOG=0` preserves pending work across a restart. With it enabled, old events
   can be acknowledged without being delivered, even though a request remains "negotiating".
4. Confirm the actual runner is alive and completes a turn. A reachable API or polling UI is not worker health.
   Record the host: a local process survives closing a panel, but not sleeping or shutting down that computer.
   Laptop-off persistence requires an independently hosted worker and a separate successful test.
5. Check owned inventory and delivery days before selecting prompts. Main bundle needs one compatible desk
   and one ergonomic chair at each participant. Desk-only needs a compatible desk. Stock can change after each run.
6. Verify the Stripe sandbox endpoint `https://exchangent.vercel.app/webhooks/stripe` and its matching signing
   secret on Vercel. A secret from `stripe listen` does not verify the deployed endpoint's events.
7. Verify Inkbox identities/tunnels without starting a duplicate worker. `npm run inkbox:smoke` must run while
   the worker is stopped: it uses the same tunnels. Identity-cap fallbacks are in-process, not Inkbox deliveries.
   Do not delete identities as part of rehearsal. Use recorded transport receipts to describe each actual hop.
8. Verify buyer/seller email destinations. Deal and sale notifications use Inkbox; Primitive confirmation is
   optional. "Queued" or "sent" is not proof of inbox arrival. Keep the UI useful if email is delayed.

## Main demo: request → competition → recovery → paid order

Allow 4–6 minutes plus variable model and email latency; never promise exact completion time or price.

1. **Seller, privately in their connected account:** inspect existing inventory. If creating a fresh business,
   add a 46-inch walnut desk (list $240, minimum $155, 2 available) and an ergonomic mesh chair (list $210,
   minimum $130, 3 available), with $15 delivery and a one-day estimate. Set "let my agent negotiate" on.
   For existing stock, do not blindly set an absolute quantity while buyers may be reserving it. Inventory
   upsert is a stocktake, not an atomic "add N" operation. Stock it before the buyer starts.
2. **Buyer, connected as Buyer:**
   > Find a desk no wider than 48 inches and an ergonomic chair, delivered in San Francisco within three days.
   > Spend at most $400 including delivery; aim for $300. Let my agent negotiate.

   Confirm the structured request has both items, `max_width_in:48`, `ergonomic:true`, the correct region,
   budget and delegation. Resolve the delivery date explicitly in the buyer's timezone. Allow at least
   three days so a two-day seller can qualify; "tomorrow" is not a reliable three-seller demonstration.
3. **Open the returned watch link.** Show each seller's opening/current all-in prices, actual recorded moves
   and offer race. Agents now concede gradually: do not promise an immediate $300 acceptance, a floor-level
   final offer, a specific winner, or the globally cheapest result before all sellers respond.
4. **Close only the panel/tab while the worker stays running.** Reopen the same request from Buying.
   Show "Saved request restored". Claim continuing work only if new saved moves actually appeared while
   closed; otherwise say the saved state recovered. This does not demonstrate a laptop-off worker.
5. **Buyer:**
   > Compare the current valid offers, including delivery and how each meets my requirements. Show me the best
   > available option. Wait for my approval before reserving or opening checkout.

   Review the exact seller, items, quantity, total, expiry and delivery estimate. Do not describe a delivery
   estimate as a carrier guarantee. If changed/expired, reload and review again.
6. **Buyer, after review:** "Reserve that exact offer and get me a test checkout link."
   Available stock decreases at reservation. It is held stock, not a completed sale.
   In Stripe's visible **test mode**, use `4242 4242 4242 4242`, a future expiry and test CVC. The human pays.
7. **Buyer:** "Check whether this order is paid." Only the verified webhook/authoritative server state
   confirms it. A success URL, a generated link or an agent's message is insufficient. Pending means wait,
   not pay again. Show the verified order and measured receipt (contacted sellers, offers/counters and
   same-seller price reduction). Do not claim uninstrumented human approvals or invented savings.
8. **Seller:** "Show my inventory and orders." Verify the matching order, held/available stock and sold count.
   Sold increases once after payment. Show the sale email only if it actually arrived. Shipping/delivery
   remains separate; any demo scan must stay labelled simulated.

## Backup: desk-only competition

> Find one desk no wider than 48 inches, delivered in San Francisco within three days. Maximum $220 all-in;
> aim for $160. Let my agent negotiate.

The current seeded catalogs can produce Alex Woodworks, Bay Desk Co, Mission Ergonomics and Exchangent
Seller Test, subject to ownership, delegation, stock, deadline and matching rules. The test desk has limited
stock: it is not guaranteed to participate. Check actual matches rather than announcing "four sellers" first.
A target is a preference, not a promised price. Show businesses that cannot meet the budget honestly.
Reserve only a still-valid reviewed offer. If Alex does not win, do not claim Alex's inventory decreased.

## Optional advanced demo: a human seller joins late

1. Owner turns their business's negotiation agent off **before** the buyer request.
2. Buyer submits the main prompt and delegates negotiation. Other businesses negotiate automatically.
3. Owner lists their open requests and inspects that request's current session/version.
4. Owner submits a genuinely competitive offer for the actual bundle, including delivery, within their own
   floors. `$310` is an example, not a required outcome. Do not invent delivery promises in the note.
5. Buyer agent may counter and prefer the new offer if it is eligible and better. Wait for actual recorded
   evidence; do not promise an exact `$300` counter or switch. A held/paid order must not silently switch sellers.
6. Owner re-reads before answering. Human buyer reviews, reserves and approves test checkout as above.
7. Restore the owner's intended delegation setting after rehearsal, and verify it saved.

## Failure and recovery checks

| Case | Expected evidence / action |
|---|---|
| No matching sellers | Explicit no-match outcome; ask the buyer before relaxing requirements. Do not animate fake negotiations. |
| Same email owns seller | Self-match excluded. Use distinct consenting accounts. |
| No stock / last unit | Out-of-stock offer cannot reserve; concurrent buyers cannot both hold the last unit. Re-read current offers. |
| Expired offer or changed version | Exclude expired offers from current ranking; stale mutations fail and re-read, without silent substitution. |
| Expired/released reservation | Return to current offers and obtain a fresh hold; do not reuse the ended checkout. |
| Payment pending / webhook delayed | Show verification, suppress duplicate pay, reconcile the existing session. Never fabricate confirmation. |
| Cancelled or declined card | No paid order; inspect the hold/session and retry only when the server permits it. |
| Duplicate/delayed payment webhook | Idempotent confirmation; no duplicate order, sold increment or refund. |
| Panel closed / browser storage missing | Recover by owned request/reservation ID from the backend. Storage is only a convenience. |
| Worker restart / failed turn | Preserve backlog; retry safely; show stalled/error truthfully. No invented progress while disconnected. |
| Worker 401 | Sync current credentials securely; restart once resolved. Do not discard events or reset stock. |
| 401/403/404 in human view | Sign in / respect ownership / show missing-request error respectively; do not treat every 404 as private access. |
| Identity cap / email delay | Show real transport and saved order state; never claim all traffic or email used Inkbox unless recorded. |
| Seller pauses agent | No new unauthorized turn; verify server rejects revoked authority. Owner can negotiate in chat. |
| After-sale problem | Use an actual paid order and current policy. Refund remains pending until verified. No live-money refund. |

## Rehearsal and public-listing gates

Run unit/type/build and disposable-Postgres checks before the live run. The live acceptance gate is a new
OAuth-created request, actual model/Inkbox turns, close/reopen with new records, human-approved Stripe test
payment, signed webhook and owner-visible stock/order. Record failures; do not relabel a mock run as live.

See `doc/connector-readiness.md` for custom-connector testing versus public-directory publication requirements.
No public listing, live payment capability or universal host compatibility is implied by this runbook.
