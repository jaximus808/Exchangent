# Manufact backend handoff

The `manufact` negotiation work is integrated into `backend/setup`. The original
Stripe reserve/checkout/webhook path is preserved. All three SQL migrations have
been applied to the shared Exchangent test project.

## Running here

- Backend: `http://127.0.0.1:8787`, started with `npm start --prefix backend`.
- MCP API base: `http://127.0.0.1:8787/api/v1`.
- Fictional sellers are seeded. Private buyer/seller/worker tokens are in the
  ignored `backend/.demo-principals.json`; never paste them into source or chat.
- Tokens expire after 24 hours and can be revoked. Re-seeding rotates credentials
  **and resets demo inventory**, so do not re-seed during a transaction.

## Tunnel and Manufact

The tunnel has not been started or configured on Manufact by this integration.
Tunnel IPv4 `http://127.0.0.1:8787`, then set:

```
EXCHANGENT_API_URL=https://<your-tunnel-host>/api/v1
```

Preserve each caller's bearer token. A single global buyer fallback token is only
appropriate for an isolated buyer-only demo server, not a shared buyer/seller
connector. Public ChatGPT/Claude account linking and OAuth remain separate work.

## Compatibility decisions

- Existing text `commerce_requests.requirements` is preserved. Negotiation stores
  JSON in `structured_requirements`; MCP still sends/receives `requirements` JSON.
- Existing `created_at` is reused.
- Verified InsForge user sessions and scoped `exg_` task delegations retain the
  authenticated activity API. The negotiation contract currently uses seeded
  64-character hex role tokens; account-linking it to user sessions is pending.
- `COMMERCE_DEMO_TOKEN` is rejected by the running server.
- The frontend text-brief flow is not yet connected to the structured matching flow.

## Verification

- 20 backend unit tests; 17 real Postgres negotiation/schema checks.
- 10 MCP tests and MCP typecheck.
- Six existing real InsForge/Stripe integration tests and four scoped-auth checks.
- A real MCP-client -> MCP-server -> running-backend -> InsForge check negotiated
  $465 -> $360 and closed its sessions without reserving inventory or charging.

Rerun the latter explicitly with `npm run test:integration --prefix mcp`.
The autonomous dispatcher/agent runner is not included in this branch; outbox
routing is ready for it to consume.
