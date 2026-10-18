# Exchangent web

Next.js app (`@exchangent/web`): the human home base, plus the **connector sign-in page** that ChatGPT
and Claude send people to when they add the Exchangent connector.

| Page | What it shows |
|---|---|
| `/` signed out | Landing: how it works, email-code sign-in (any email; a new one creates the account), how to connect Claude |
| `/` signed in | Dashboard. **Overview** (live negotiations, deals, best offer, businesses), **Buying** (requests with best offer, seller count and agent on/off; per request the current offers with Reserve & pay → Stripe test checkout, the receipt once paid, and every agent message per seller), **Selling** (each business: inventory with list price and private minimum, add an item, agent on/off, live negotiations from the seller's side), **Connect** (MCP URL and Claude / Claude Code steps). Deep links: `/#buying`, `/#selling`, `/#connect` |
| `/watch/<request_id>` | Live, projector-friendly view of one request for its buyer: one column per seller, chat bubbles with price, note, who moved and the Inkbox A2A hop (from → to, message ID). Polls every 1.5 s while negotiating. Dark by default, light toggle, full-screen button |

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
