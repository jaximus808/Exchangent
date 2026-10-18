# Exchangent lives in chat

The primary buyer and seller experience is an MCP App rendered inside ChatGPT or
Claude. Manufact hosts the MCP server and UI resources; Vercel hosts the commerce
API. `web/` is an optional earlier workspace prototype, not the demo entry point.

## What the human sees

- Buyer says what they need in chat. `create_buy_order` shows matched businesses.
- `get_buy_order` and `list_offers` show actual seller offers, delivery/tax totals,
  expiry, the private buyer limit when available, and negotiation activity.
- Human reviews an offer and clicks the explicit reserve/checkout button.
  The widget calls `reserve_offer`, then `get_checkout_link` through the host bridge.
- The host opens Stripe checkout externally. Widgets never read payment details.
- The panel polls `get_reservation_status`. Only a backend-confirmed order is shown
  as paid. Closing a panel does not lose backend state; ask the assistant to reopen it.
- Sellers use `list_my_requests`, `get_negotiation` and `get_inventory` to view their
  own requests, history and private pricing. Their agent makes the actual offers
  through the existing tools. Host-supported follow-up buttons ask the chat agent
  to respond; unsupported hosts retain the normal text conversation.

## Integration changes

Eight tools now declare separate `view` bindings. `registerTools` returns ToolRefs,
which `index.ts` exports for typed React hooks. No business API, deployment config,
model runner or authentication semantics were changed.

The UI files are under `views/`; shared components are under `views/shared/`.
They use mcp-use 2.10.1 React hooks, bundled inline assets, the existing server
credentials, host-mediated tool calls and host-mediated link opening. No separate
website login, browser tokens, direct database fetches or personal Link access.
The panels use a white/neutral palette and resize to the chat container.

## Build and deploy

```
npm ci --prefix mcp
npm test --prefix mcp
npm run typecheck --prefix mcp
npm run build --prefix mcp
```

Deploy the built entry using the existing Manufact project. Source-only imports
will not prime UI resources; tests now exercise the compiled entry too.

Set `EXCHANGENT_API_URL=https://exchangent.vercel.app/api/v1`. The deployment health
check now returns HTTP 200. The embedded actions were tested against the local
backend, not the deployed API. No cloud settings were changed during this work.

Keep buyer/seller authorization per caller. Do not deploy one shared buyer token
as the global fallback on a multi-user public connector. Public OAuth/account
linking and the autonomous dispatcher remain separate teammate-owned work.

## Verified and remaining

Local MCP resource loading and the real negotiation API are checked. The buyer
panel has rendered competing live test offers inside the Manufact inspector's
MCP App iframe, and its reserve/link flow opened hosted Stripe sandbox checkout.
The order-status panel rendered the previously verified $365 sandbox order. The
unpaid $360 UI-test checkout was expired afterward; no additional payment was made.
ChatGPT/Claude production connector rendering still needs acceptance testing after
Manufact deployment and per-user authentication are configured. The model keeps
its reasoning in chat; the panels show recorded offers and actions.

## Payment approval polish (fee-free demo)

The review card sends `expected_total_cents` with `reserve_offer`. The new optional
four-argument `commerce_reserve` overload rejects a different amount atomically;
legacy callers remain supported. Apply
`migrations/20261018000100_payment-approval.sql`, deploy the backend, then deploy
this MCP build. Deploying the new widget before the backend/migration will make
its reservation action fail rather than bypass the price check.

Reservation status now includes the reserved item snapshots, seller name,
delivery/tax breakdown and expiry. The panel hides checkout while payment is
pending, and shows confirmation only for a consumed reservation with a confirmed
order. Stripe success/cancel pages direct the human back to their conversation;
neither redirect confirms payment or cancels a hold. The existing verified
webhook remains the only payment confirmation path. No commission is charged.

## Competition and recovery polish

Buyer panels compare each business's first recorded offer with its current total,
show delivery estimates and verified item fit, and highlight the lowest eligible
total. Eligibility excludes expired, superseded and over-budget offers. A seller
delivery estimate is not a guaranteed delivery date. The progress indicator
distinguishes negotiation, human approval, payment verification and confirmation.

Deploy the backend before the MCP build: request/offer reads now optionally include
`opening_total_cents`, and reservation status includes `request_id` so an ended
checkout can return to the saved request. No new migration is required beyond the
existing stale-hold migration. When checkout rejects an expired, unattempted hold,
the backend releases it; attempted or bound Stripe sessions remain protected.

Verified in the local Manufact inspector against disposable Postgres fixtures:

| Scenario | Result |
| --- | --- |
| Competing offers, desktop and mobile | Actual opening/current totals, delivery and item fit displayed |
| Reopen saved reservation | Restores the hold rather than making another reservation |
| Checkout preparation failure | Hold remains recoverable; retry and refresh actions remain available |
| Pending payment | Verification message, no second payment button |
| Reopen confirmed request | Fetches reservation receipt and shows confirmation |
| Failed payment | Returns to current offers and clears the old checkout state |
| Expired offers | Review disabled; no lowest-eligible badge |
| Seller inventory | Stock, list prices and private minimums displayed with business navigation |

These fixtures simulate Stripe events; they do not prove the deployed webhook or
production ChatGPT/Claude rendering. Recheck the deployed sandbox payment loop and
both host clients after deployment. Seller OAuth ownership and inventory access
are also covered by real-Postgres integration tests.

Live seller acceptance passed on the deployed `fast-cloud-tpp4j` connector after
human consent: `whoami` reported OAuth seller scope for the separate fictional
Exchangent Seller Test business, and `get_inventory` rendered only its one
Fictional 46-inch desk (one available, $200 list, $150 private minimum). This
verifies the existing deployed seller flow; the new panel polish above still
requires deployment.

Merge handoff: deploy the backend, then both existing Manufact environments with
this MCP build. The web root and OAuth page on `web-five-jet-34.vercel.app` and
`exchangent.vercel.app/health` returned HTTP 200 during the final check. The local
runner credential returned 401 from the deployed backend, so check its current
credentials before the live agent rehearsal; do not treat site availability as
proof that negotiation or the deployed Stripe webhook is working end to end.
