# Backend setup

## Current status

- Backend work branch: `backend/setup`.
- API and schema contract: `backend/CONTRACT.md` (broader target).
- Transaction foundation implemented in `migrations/` and `backend/src/`.
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

Use Node 22 or later. Dependencies and private `backend/.env.local` are configured
on this machine. Another machine must link the project and set its own secrets;
`backend/.env.example` lists names only.

```sh
npm ci --prefix backend
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

The loopback server's buyer principal is configured by `DEMO_BUYER_ID`; its random
`COMMERCE_DEMO_TOKEN` is required as a Bearer credential. The proof CLI calls the
same commerce module directly. Do not expose this single-buyer demo API publicly.

## Negotiation loop

Spec: `doc/negotiation-contract.md`. Schema and RPCs: `migrations/20261017230000_negotiation.sql`
(additive; apply after the checkout foundation). Routes live in `src/http.mjs`, rules and
redaction in `src/negotiation.mjs`. Bearer tokens resolve through `commerce_principals`
(sha256 only); the legacy `COMMERCE_DEMO_TOKEN` still means `DEMO_BUYER_ID`.

```sh
npm run seed:negotiation --prefix backend   # writes backend/.demo-principals.json (gitignored)
npm run test:db --prefix backend            # throwaway Docker postgres:16, both migrations, HTTP loop
```

The seed reuses `DEMO_BUYER_ID` as the buyer when set, resets demo stock and prices, and
rotates every seed token on each run. `test:db` never touches InsForge.

## Remaining integration work

- Port the handlers to the agreed Next.js layout and replace demo authentication
  with verified user and worker principals before public deployment.
- Wire request creation, matching, seller offer creation and negotiation sessions;
  this milestone starts with a fixed seller-authorized offer.
- Add scheduled reconciliation: unpaid bound sessions release stock only after
  Stripe confirms expiry/failure. Never release based solely on a local timestamp.
  Unbound holds also need a safe cleanup path; ambiguous checkout creation retries
  must use the same Stripe idempotency key before stock can be released.
- Connect the confirmation outbox to Primitive, with durable delivery retries.
- Claim the Stripe sandbox and configure deployed webhook secrets separately.

## Hackathon credits

The team has reported a $500 Stripe hackathon credit grant. Redemption and eligible
uses have not been checked. Keep the credit grant separate from test payment
balances and do not make live charges to test the application.

## Deploy on Vercel

`backend/api/index.mjs` serves the same handler as `src/server.mjs` as one Vercel
function; `backend/vercel.json` rewrites every path to it.

- Vercel project: Root Directory `backend`, Framework Preset `Other`, branch `manufact`.
- Environment variables (test keys only): `INSFORGE_URL`, `INSFORGE_API_KEY`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_INTEGRATION_ID`,
  `COMMERCE_DEMO_TOKEN`, `DEMO_BUYER_ID`, `COMMERCE_BASE_URL=https://<app>.vercel.app`,
  and `NODEJS_HELPERS=0` so the Stripe webhook receives the raw body.
- Stripe: add a sandbox webhook endpoint `https://<app>.vercel.app/webhooks/stripe`
  for the four checkout events and use its signing secret as `STRIPE_WEBHOOK_SECRET`.
- Check: `curl https://<app>.vercel.app/health` returns `{"status":"ok","mode":"test"}`.
