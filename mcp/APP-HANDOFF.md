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
