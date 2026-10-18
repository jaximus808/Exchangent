# Exchangent web

Next.js app (`@exchangent/web`): the human home base, plus the **connector sign-in page** that ChatGPT
and Claude send people to when they add the Exchangent connector.

| Page | What it shows |
|---|---|
| `/` signed out | Landing: how it works, email-code sign-in (any email; a new one creates the account), how to connect Claude |
| `/` signed in | Dashboard. **Overview** (live negotiations, deals, best offer, businesses), **Buying** (requests with best offer, seller count and agent on/off; per request the current offers with Reserve & pay → Stripe test checkout, the receipt once paid, and every agent message per seller), **Selling** (each business: inventory with list price and private minimum, add an item, agent on/off, live negotiations from the seller's side), **Connect** (MCP URL and Claude / Claude Code steps). **Orders** (Buying): each paid order's timeline (paid → shipped → delivered, with simulated scans labelled), "It arrived", **Report a problem** and every case with accept / counter / decline and refunds. **Selling** also lists orders to ship (Mark shipped; Simulate delivery in test mode), problem cases to answer, and a resolution-policy editor. Order sections stay hidden on a backend without the order routes. Deep links: `/#buying`, `/#selling`, `/#connect` |
| `/watch/<request_id>` | Live, projector-friendly view of one request for its buyer: one column per seller, chat bubbles with price, note, who moved and the Inkbox A2A hop (from → to, message ID). Polls every 1.5 s while negotiating. Light workspace, offer race, verified purchase finish, saved-state recovery, evidence receipt and full-screen button |

The commerce proxy (`app/api/commerce/[...path]`) only forwards the paths the pages use, with the signed-in
InsForge session. Data shapes: `doc/conversation-contract.md`. Requests are placed from Claude (structured
requirements); the web app reads, reserves and pays.

```sh
npm ci
cp .env.example .env.local   # fill in values
npm run dev                  # http://127.0.0.1:3000
npm run typecheck && npm run build
```

## Connector sign-in (OAuth)

`/oauth/authorize` implements the authorize page from [`doc/oauth-contract.md`](../doc/oauth-contract.md).
The MCP server's OAuth proxy redirects the browser here with
`response_type=code&client_id=…&redirect_uri=…&state=…&scope=…[&code_challenge=…&code_challenge_method=S256]`.

1. The query is validated on the server. A bad request shows an error page and never redirects.
2. Signed out: email one-time-code sign-in (the same `app/actions.ts` InsForge flow). A new email
   creates an account. After verifying, the page re-renders with the same query.
3. Signed in: the server calls `GET ${COMMERCE_API_URL}/api/v1/oauth/targets` with the
   `insforge_access_token` cookie. The backend validates the client and the exact redirect URI.
   Unknown client or redirect URI shows an error page; `401` shows sign-in again.
4. Consent: the person picks their buyer account or one business they own, then Approve or Deny.
   - **Approve** (server action) posts to `${COMMERCE_API_URL}/api/v1/oauth/authorize` and
     redirects to the backend's `redirect_to` (only if it points at the validated `redirect_uri`).
   - **Deny** re-checks the redirect URI with the targets call, then redirects to
     `redirect_uri?error=access_denied&state=…`.

Security notes: the InsForge token is only ever read from the cookie on the server and is never
sent to client components. Server actions re-validate every parameter and rely on Next's built-in
Origin/Host check for CSRF. `/oauth/*` responses send `Cache-Control: no-store`,
`Content-Security-Policy: frame-ancestors 'none'` (plus the global `X-Frame-Options: SAMEORIGIN`)
and `Referrer-Policy: no-referrer`.

Files: `app/oauth/authorize/` (page, server actions, backend calls, client forms, styles) and
`lib/oauth.ts` (parameter validation and URL helpers).

### Environment

| Variable | Where | Value |
|---|---|---|
| `COMMERCE_API_URL` | server | `https://exchangent.vercel.app` in production (defaults to `http://127.0.0.1:8787`) |
| `WEB_ORIGIN` | server | Optional, comma-separated origins allowed to write through `/api/commerce/*`, for example `https://web-five-jet-34.vercel.app`. When unset, only the request's own origin is accepted (plus its loopback aliases in local development). |
| `NEXT_PUBLIC_INSFORGE_URL` | build + server | InsForge project URL |
| `NEXT_PUBLIC_INSFORGE_ANON_KEY` | build + server | InsForge anon key |

Without the InsForge variables the page renders a "Sign-in is unavailable" state instead of crashing.

### Deploying on Vercel

- Create a **separate Vercel project** for this app (the backend is its own project at
  `exchangent.vercel.app`). Import the same repository and set **Root Directory** to `web`;
  the framework preset is Next.js and the default build command works.
- Add the three variables above for Production (and Preview if you test there). `NEXT_PUBLIC_*`
  values are inlined at build time, so redeploy after changing them.
- The authorize URL is `https://<web-project-domain>/oauth/authorize`. Point the MCP server's
  `oauthProxy` upstream authorize endpoint at it. The token endpoint stays on the backend
  (`https://exchangent.vercel.app/api/v1/oauth/token`).
- In the InsForge dashboard, allow the web project's domain if InsForge restricts origins or
  redirect URLs.

## Live watch redesign

The watch page is a read-only observer: compact seller comparison, one filterable
activity feed, and a reservation-backed outcome. It defaults to the light workspace
style. Completed orders are not labeled paused. Pending payments keep a verifying
state; the selected seller comes from the reservation, not a later cheapest offer.
“View order” opens the same request using `?request=<id>#buying`.

Selling refreshes saved business inventory every five seconds while visible,
refreshes on return, shows read failures and labels recent stock/sale changes.
The earlier separate inventory draft is preserved in Git stash history and must
not be applied wholesale over this newer dashboard/API contract.

Local presentation checks: `node --test web/test/*.test.ts` from the repository root.
The broader lifecycle audit and demo acceptance gate are in
`doc/agent-commerce-readiness.md`.

Buying now recovers checkout from the request's saved reservation, uses request-specific
cache keys and rejects cached receipts from another request. Pending payment hides
repeat-payment controls; a confirmed receipt requires consumed/confirmed states.

The live watch view includes an Anatomy-based isometric exchange figure. Seller stations filter the transcript; pagination handles additional sellers. Message packets play once for newly recorded moves, never for initial history or repeated polls. Reduced motion, offscreen views and reconnecting states suppress packet animation. No generated backdrop is included.

Buyer and seller threads also expose expandable seller price histories. Comparison charts share a zero-based price scale, exclude buyer counters and retain expired prices only as history. These read-only visuals add no new permission or approval steps; MCP tools remain the source for agent actions. Anatomy attribution is in `components/iso/ANATOMY-LICENSE`.

The watch screen defaults to a scan view: comparable offer panels and three latest moves. Full history, original messages, transport receipts and price histories expand on demand. The compact progress rail reflects saved request/payment state. Muted green marks the selected purchase; labels and icons preserve meaning without relying on color. Loading/matching motion is disabled under reduced motion; no model reasoning, fake activity or pretend voice controls are shown.

The offer race charts recorded seller offers on a shared zero-based price axis. The horizontal axis is each seller's own offer sequence, not elapsed time or a claim of synchronized rounds. Buyer counters never enter the price lines. Select a point (pointer, keyboard, or offer picker) to inspect its amount, time and recorded message; seller selection also filters the shared activity feed. Historical/expired prices remain visible with status labels and never become payment approval. Endpoint motion follows data updates and respects reduced motion. Empty, single-offer, flat-price and uneven-history series are supported without external chart libraries or new MCP tools.

The completion bridge loads the signed-in buyer's reservation receipt and verifies request, reservation, seller, currencies, totals and item arithmetic before showing “Deal complete.” A consumed reservation alone is insufficient: a confirmed order must also exist. It shows purchased quantities, not private seller stock totals or a fulfillment claim. A live confirmation transition gets one restrained animation; opening an already completed order is static. Receipt failures offer retry and never initiate checkout.

Seller-owned inventory panels separately show the latest observed Available/Sold before→after counts, capped at three changed items. Available decreases at reservation; Sold increases on payment confirmation. These are snapshot differences (potentially multiple changes between refreshes), not a fabricated transaction ledger or buyer-visible stock feed. No database, payment or MCP permission changes are needed.

Recovery always re-reads the authorized request from the backend. A best-effort, account/request-scoped browser checkpoint stores only event identifiers and last-view time (no tokens, message text, prices, budgets or floors). Reopening compares identifiers to say how many newly available records exist; it does not claim worker health or that records were generated while the browser was closed. Expired/corrupt checkpoints and blocked storage gracefully fall back to the server view. Opening history does not replay it as new traffic.

“What happened” counts distinct sellers with recorded contact evidence, deduplicated seller offers plus buyer counters, same-seller price reduction, and payment state. Payment shows Verified only for the matching complete order receipt. It omits human-approval and tool-call counts because those are not instrumented. Evidence contains projected conversation records and delivery metadata, never seller floors or raw private tool results.
