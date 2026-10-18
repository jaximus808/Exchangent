# Backend setup

## Current status

- Backend work branch: `backend/setup`.
- API and schema contract: `backend/CONTRACT.md` (broader target).
- Transaction foundation implemented in `migrations/` and `backend/src/`.
- Authenticated requests, scoped agent credentials and status reads are documented
  in `API.md`. All three migrations, including negotiation, are applied to the test backend.
- Stripe sandbox account: `acct_1URbMuIve5dAZQ3d`. Test-only CLI credentials exist
  locally. Claim the temporary sandbox before October 24, 2026.
- A real sandbox Checkout Session was paid with Stripe's test card. The local
  webhook verified its signature and confirmed exactly one order. See `PROOF.md`.
- No live payment or personal Link connection has been created.
- InsForge project `Exchangent` is provisioned and linked in `us-west`.
  Project ID: `f513af2f-fa69-47c0-8155-e1c5d78d1bf4`.
  Backend URL: `https://i3dmj4z4.us-west.insforge.app`.
  Organization ID: `b354940c-478c-42ce-875f-18796f7d6fbe`.
  The checkout foundation migration and explicit disposable demo fixtures are applied.

## Local secrets

`.insforge/`, `.stripe/` and environment files are ignored. Never commit project
configuration files containing admin keys. Each teammate should authenticate and
link their own CLI to the same project instead of copying credentials in chat.

After an owner invites the teammate to the organization, link with:

```sh
npx -y @insforge/cli link --project-id f513af2f-fa69-47c0-8155-e1c5d78d1bf4 --org-id b354940c-478c-42ce-875f-18796f7d6fbe --yes
```

Our Next.js API will own Stripe directly, with InsForge storing application state;
the InsForge managed-payments module is not the selected integration path.

## Run the milestone locally

Use Node 22.18 or later: the backend is TypeScript and Node runs the `.ts` sources
directly (type stripping), so local use needs no build step. Dependencies and private
`backend/.env.local` are configured on this machine. Another machine must link the
project and set its own secrets; `backend/.env.example` lists names only.

```sh
npm ci --prefix backend
npm run typecheck --prefix backend
npm test --prefix backend
stripe listen --forward-to http://127.0.0.1:8787/webhooks/stripe --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired
```

Save that listener's signing secret as `STRIPE_WEBHOOK_SECRET` in
`backend/.env.local`, then start the server in a separate terminal:

```sh
npm start --prefix backend
npm run proof --prefix backend
```

`proof` deliberately creates new disposable fixtures and prints a complete hosted
Checkout URL. Use that full URL, including its fragment. Pay with Stripe's sandbox
card `4242 4242 4242 4242`, a future date and any three-digit CVC. Use a fictional
buyer name/email and leave Link saving disabled. No real payment data is needed.

```sh
npm run proof --prefix backend -- --status
npm run test:integration --prefix backend
```

Integration tests require the locally saved public `INSFORGE_ANON_KEY`, a running
server and a completed proof checkout. They create additional disposable test rows.

The API now requires a verified InsForge user access token or an explicit scoped
delegation. `COMMERCE_DEMO_TOKEN` no longer grants HTTP access. `DEMO_BUYER_ID` is
only an administrative proof fixture; the proof CLI calls the commerce module
directly. Keep the server local pending frontend sign-in and deployment review.

With the authenticated server running, run
`npm run test:auth-integration --prefix backend`. These tests bootstrap disposable
delegations administratively, exercise the actual API, and revoke them afterward.
They do not claim to test a complete human OAuth/email verification flow.

## Negotiation loop

Spec: `doc/negotiation-contract.md`. Schema and RPCs: `migrations/20261017230000_negotiation.sql`
(apply after the checkout and authenticated-commerce migrations). Routes live in `src/http.ts`, rules and
redaction in `src/negotiation.ts`, shared row, RPC and principal types in `src/types.ts`.
Bearer tokens resolve through `commerce_principals` (sha256 only). Seed tokens expire after 24 hours and support `revoked_at`;
the retired `COMMERCE_DEMO_TOKEN` is not accepted by the running server.
The server dispatches 64-character hex demo tokens to these role-based routes;
verified user sessions and `exg_` task delegations retain the scoped API in `API.md`.
Negotiation tools currently require the seeded role token, not a user session or
scoped delegation. Connector access tokens (`exc_`) from the OAuth flow below also
use these routes, as the buyer or one owned business.

```sh
npm run seed:negotiation --prefix backend   # writes backend/.demo-principals.json (gitignored)
npm run test:db --prefix backend            # throwaway Docker postgres:16, all migrations, production HTTP loop
```

The seed reuses `DEMO_BUYER_ID` as the buyer when set, resets demo stock and prices, and
rotates every seed token on each run. `test:db` never touches InsForge.

## Connector OAuth (ChatGPT and Claude)

Spec: `doc/oauth-contract.md`. Routes and errors are listed in `API.md` under "Connector OAuth".
To go live:

1. Apply `migrations/20261018000200_connector-oauth.sql` to InsForge, after the payment-approval
   migration. It adds three tables (RLS on, with no anon or authenticated access) and eight RPCs that only
   `project_admin` can execute. One of them, `commerce_auth_user_by_email`, is `SECURITY DEFINER`
   because it reads `auth.users.email`.
2. Register the MCP server as the OAuth client. Its redirect URI must be exactly the proxy callback
   `<MCP_URL>/mcp/oauth/callback`. The ID and secret come from `EXCHANGENT_OAUTH_CLIENT_ID` and
   `EXCHANGENT_OAUTH_CLIENT_SECRET`, here read from the MCP env file. Without a secret, the script
   generates one and prints it once. Only its SHA-256 digest is stored.

   ```sh
   npm run oauth:client --prefix backend -- --name "Exchangent MCP" \
     --redirect-uri "<MCP_URL>/mcp/oauth/callback" --env-file ../mcp/.env.production.local
   ```

   Re-running updates the name and redirect URIs. A secret it isn't given stays unchanged, and
   `--rotate-secret` issues a new one.
3. Have the demo person sign in once on the web app at `/oauth/authorize` so that InsForge
   has their account. Then make them the owner of a demo business:

   ```sh
   npm run assign:seller --prefix backend -- --email <person@example.com> --seller "Bay Desk Co"
   ```

Both scripts read `backend/.env.local` (`INSFORGE_URL`, `INSFORGE_API_KEY`). With `DATABASE_URL`
set, they use a local Postgres instead. `npm run test:db` runs the whole flow against a
throwaway container (`test/sql/oauth.db.ts`). That covers registration, consent, token exchange,
connector buy and sell routes, refresh rotation, reuse revocation and every failure case. The test
files run one at a time because they share the demo seed.

## Order confirmation email (Primitive)

After the Stripe webhook confirms an order, the backend emails the buyer one receipt through
Primitive (`src/order-email.ts`, REST `POST https://api.primitive.dev/v1/send-mail`, docs:
https://docs.primitive.dev/docs/sending). The email has the seller name, the reserved items,
subtotal, delivery, tax, total and the order ID: the same numbers as `GET /api/v1/reservations/:id`.

- **Off by default.** It runs only when both `PRIMITIVE_API_KEY` (an organization API key,
  `prim_...`) and `PRIMITIVE_FROM` (an address on a verified Primitive sending domain, for example
  `orders@<your-subdomain>.primitive.email`) are set. With one of them missing, it logs
  `order_email disabled` and does nothing.
- **Never fails the webhook.** Send errors are logged as `order_email failed order=<id> reason=<code>`
  (never the address or key). Stripe still gets its 200 response.
- **At most one email per order.** The `order.confirmed` outbox row is marked delivered after
  Primitive accepts the send, and is checked before sending. Every attempt uses the
  `Idempotency-Key` `exchangent-order-confirmed-<order_id>`, which Primitive keeps with no expiry.
  A failed send leaves the row pending, so Stripe's next retry of the event sends it.
- The buyer's address is their InsForge account email (`commerce_actors.auth_user_id` →
  `auth.users.email`). Demo buyers without an account are skipped (`reason=no_recipient`).

To turn it on:

1. Apply `migrations/20261018000300_order-email.sql` to InsForge, after the connector OAuth
   migration. It adds two RPCs that only `project_admin` can execute. `commerce_order_email` is
   `SECURITY DEFINER` because it reads `auth.users.email`; `commerce_ack_order_email` marks the row delivered.
2. In the Primitive dashboard, create an organization API key, and use a sending domain: the managed
   `*.primitive.email` subdomain works with no DNS setup; a custom domain needs its DNS records verified.
3. Make sure Primitive lets you send to buyers. New organizations can only send to their own domains,
   organization members and people who emailed them first. Buyers are arbitrary addresses, so ask Primitive
   to enable `send_to_any_domain` (check with `curl https://api.primitive.dev/v1/send-permissions -H
   "Authorization: Bearer $PRIMITIVE_API_KEY"`). Otherwise each send fails with `403 recipient_not_allowed`
   (logged, the webhook still succeeds).
4. Set `PRIMITIVE_API_KEY` and `PRIMITIVE_FROM` in Vercel (Production) and in `backend/.env.local`, then redeploy.

## Self-serve businesses and the seller agent

Spec: `doc/signup-contract.md`. Routes: `API.md` ("Businesses and the seller agent").

To turn it on:
1. Apply `migrations/20261018000600_self-serve-signup.sql` to InsForge, after `20261018000500`.
   - It is additive: it adds two `commerce_sellers` columns, six RPCs and one trigger, and re-creates
     `commerce_worker_events` and `commerce_ack_event`.
   - It adds no unique index on business names, because production already has duplicate test-seller
     names. It applies cleanly on top of them.
2. Deploy the backend.
3. Signed-in people can then register businesses from the consent page or with the `register_business`
   MCP tool, and stock them. The runner's worker token mints seller agent tokens on demand. No seeding or
   `agents:tokens` run is needed for a new business.

## Remaining integration work

- Port the handlers to the agreed Next.js layout and connect the frontend's
  verified InsForge sign-in sessions. Complete a real human-login acceptance test.
- Connect the frontend request form and user sessions to the structured negotiation
  contract. The demo role API now creates matched sessions and negotiation events;
  the frontend text-brief API still queues `request.created` for later processing.
- Connector OAuth is implemented, but the full browser flow through the deployed web consent
  page and Manufact MCP proxy still needs a live acceptance run.
- Add scheduled reconciliation: unpaid bound sessions release stock only after
  Stripe confirms expiry/failure. Never release based solely on a local timestamp.
  Unbound holds also need a safe cleanup path; ambiguous checkout creation retries
  must use the same Stripe idempotency key before stock can be released.
- Order confirmation emails retry only when Stripe retries the webhook. Add a scheduled sweep of
  pending `order.confirmed` outbox rows if delivery must survive Stripe giving up.
- Claim the Stripe sandbox and configure deployed webhook secrets separately.

## Hackathon credits

The team has reported a $500 Stripe hackathon credit grant. Redemption and eligible
uses have not been checked. Keep the credit grant separate from test payment
balances and do not make live charges to test the application.

## Deploy on Vercel

`backend/api/index.ts` serves the same app as `npm start` (`createApp` in
`src/server.ts`, including scoped authentication) as one Vercel function;
`backend/vercel.json` rewrites every path to it. A public deployment is still a
test-mode API: review it with the backend owner before sharing the URL.

- Vercel project: Root Directory `backend`, Framework Preset `Other`, branch `manufact`.
- Build: `backend/vercel.json` sets `"buildCommand": "npm run build"`, which compiles
  `src/` to `dist/` (`tsconfig.build.json`). `api/index.ts` imports the compiled
  `../dist/*.js`, because Vercel compiles the function file itself but is not relied on
  to resolve `.ts` imports from `../src`. `dist/` is gitignored; do not commit it.
- Environment variables (test keys only): `INSFORGE_URL`, `INSFORGE_API_KEY`,
  `INSFORGE_ANON_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_INTEGRATION_ID`,
  `COMMERCE_BASE_URL=https://<app>.vercel.app`, and `NODEJS_HELPERS=0` so the Stripe
  webhook receives the raw body. Optional: `PRIMITIVE_API_KEY` and `PRIMITIVE_FROM` turn on the
  order confirmation email (see "Order confirmation email" above). Until they are set, every request returns a 500
  naming the failing check (for example `missing_INSFORGE_URL` or `test_key_required`).
- Stripe: add a sandbox webhook endpoint `https://<app>.vercel.app/webhooks/stripe`
  for the four checkout events and use its signing secret as `STRIPE_WEBHOOK_SECRET`.
- Check: `curl https://<app>.vercel.app/health` returns `{"status":"ok","mode":"test"}`.
