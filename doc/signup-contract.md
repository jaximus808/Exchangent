# Self-serve sign-up and seller agents

The buyer and the seller are different people, and nobody has to be seeded. Anyone signs in with any email
(InsForge email code, which creates the account), then connects their assistant as a **buyer** or as a
**business** they own. A new business is created in that same step, or later with the `register_business` MCP
tool. The owner stocks it with MCP tools. A platform seller agent negotiates for every business whose owner
left "let my agent negotiate" on, in the same way the platform buyer agent negotiates for delegated orders.

Seeded demo sellers (Bay Desk Co, Mission Ergonomics, SoMa Office Supply) keep working as competitors.

## Database: `migrations/20261018000600_self-serve-signup.sql`

Additive only.

**`commerce_sellers` gains:**
- `delegate_negotiation boolean NOT NULL DEFAULT true`
- `created_at timestamptz NOT NULL DEFAULT now()`
- no unique index on the name. Production already has duplicate names: 25 rows named "Integration test
  seller". Instead, `commerce_register_business` and `commerce_update_business` take
  `pg_advisory_xact_lock(hashtext('commerce_business_name:'||lower(trim(name))))` for a new or changed name.
  They raise `business_name_taken` when any other seller, enabled or not, has the same `lower(trim(name))`.

**Functions.** Each one is granted to `project_admin` only, like the earlier migrations. Each raises snake_case
codes.

| Function | Behavior |
|---|---|
| `commerce_register_business(p_actor uuid, p_name text, p_service_area text, p_delivery_cents integer, p_delivery_days integer)` | **Inputs:** the name is trimmed and must be 2–80 characters. `service_area` matches `^[a-z_]{2,40}$` and defaults to `san_francisco`. `delivery_cents` is 0–100000 and defaults to 0. `delivery_days` is 0–30 and defaults to 2.<br>**Limits:** at most 5 businesses per actor (`business_limit`).<br>**Result:** creates an enabled business owned by `p_actor` and returns `commerce_business_json`. |
| `commerce_business_json(p_seller uuid)` | Returns `{seller_id, name, service_area, delivery_cents, delivery_days, delegate_negotiation, enabled, agent_handle, created_at, owner_email}`.<br>`owner_email` comes from `auth.users` through the owner actor. It is null for demo actors without an account. The function is SECURITY DEFINER for the `auth.users` read and needs a narrow `search_path`.<br>Only seller-scoped callers (the owner's connector or the seller agent) ever see this. |
| `commerce_update_business(p_seller uuid, p_patch jsonb)` | **Patchable keys:** `name`, `service_area`, `delivery_cents`, `delivery_days`, `delegate_negotiation`, all with the same validation as register. Any other key raises `invalid_input`.<br>**Delegation off:** turning `delegate_negotiation` from true to false revokes this seller's unrevoked `agents:seller-agent:%` principals.<br>**Result:** `commerce_business_json`. |
| `commerce_upsert_inventory(p_seller uuid, p_item jsonb)` | **Item keys:** `sku` (optional; when missing it is derived from the title as lowercase-dash, max 60), `title` (1–200), `category` (`^[a-z_]{2,40}$`), `attributes` (object, default `{}`), `list_cents` (> 0), `floor_cents` (> 0 and ≤ `list_cents`), `available` (≥ 0).<br>**Write:** inserts or updates by `(seller_id, sku)`. Lowering `available` below what is held is fine: holds already moved stock out of `available`.<br>**Result:** the item as `commerce_seller_inventory` shapes it, including `floor_cents`. No outbox row. |
| `commerce_mint_seller_agent_token(p_seller uuid, p_token_hash text, p_hours integer)` | **Requires** the seller to be enabled with `delegate_negotiation`, else `not_delegated` (`seller_not_found` if it doesn't exist).<br>**Writes** a `commerce_principals` row: `scope 'seller'`, `seller_id`, `actor_id` = the seller's owner, `label 'agents:seller-agent:'||seller_id`, `expires_at now()+hours`. `p_hours` is 1–72 and defaults to 24.<br>**Result:** `{seller_id, name, expires_at, agent_handle}`. |
| `commerce_worker_events` (re-create) | **Unchanged:** the existing four kinds and fields.<br>**New field:** `route.seller_delegated` (the seller's `delegate_negotiation`).<br>**New kind** `order.confirmed`, joined through `commerce_orders`:<br>• `route = {to_role:'seller', seller_id, request_id, buyer_id, agent_handle, delegated, seller_delegated}`<br>• `payload = {order_id, reservation_id, request_id, seller_id, total_cents, currency, title}`<br>• no buyer email, no budget, no floors. |

## Backend routes

| Route | Who | Behavior |
|---|---|---|
| `POST /api/v1/businesses` with an InsForge **user session** (server.ts scoped path, `principal.kind==='user'`) | Consent page | Body: `{name, service_area?, delivery_cents?, delivery_days?}`. Calls register and returns the business JSON with 201. |
| `POST /api/v1/businesses` with a **buyer** role or connector token (negotiation handler) | `register_business` MCP tool | Same body. Returns `{business, next}`, where `next` says: "Reconnect Exchangent in your assistant and choose <name> to manage it." `buyer_agent` and other scopes get 403. |
| `GET /api/v1/seller/business` | seller | `commerce_business_json(p.seller_id)` |
| `PATCH /api/v1/seller/business` | seller | Updates settings. Agent tokens (label `agents:seller-agent:%`) get 403 `forbidden`, so only the owner changes settings. |
| `POST /api/v1/seller/inventory` | seller | Upserts one item (the body is the item). Agent tokens get 403. Idempotent by SKU, so no Idempotency-Key. |
| `POST /api/v1/worker/sellers/:id/token` | worker | Body `{hours?}`. Mints a 64-hex token (`randomBytes(32)`) and stores only its sha256 hash. Returns `{token, seller_id, name, expires_at, agent_handle}`. |

`RolePrincipal.label` already exists. Agent tokens are recognized by `label` starting with `agents:`.

## MCP tools (`mcp/src/tools.ts` and `adapter.ts`)

Shared by the bearer and OAuth deployments.

| Tool | Scope | Purpose |
|---|---|---|
| `register_business` | buyer | `{name, service_area?, delivery_cents?, delivery_days?}`. Creates a business owned by the signed-in person, and says to reconnect and choose it. |
| `get_business` | seller | Profile and settings, including whether the agent negotiates. |
| `update_business` | seller | `{name?, service_area?, delivery_cents?, delivery_days?, agent_negotiates?}`. `agent_negotiates` maps to `delegate_negotiation`. |
| `upsert_inventory_item` | seller | `{sku?, title, category, attributes?, list_cents, floor_cents, available}`.<br>• **Matching:** the description explains it. A request item `{category:'desk', max_width_in:48}` matches `attributes.width_in <= 48`, and `{category:'chair', ergonomic:true}` matches `attributes.ergonomic === true`.<br>• **Privacy:** the floor is private, and buyers never see it. |

## Consent page (`web/app/oauth/authorize`)

The choices are **Buyer account**, the businesses the person owns, and **Create a business**.

When **Create a business** is chosen:
- The form shows a business name input (required) plus optional delivery fee and delivery days.
- On Approve, the server action calls `POST /api/v1/businesses` with the user's session, then authorizes
  `seller:<new id>`.
- Errors (`business_name_taken`, `business_limit`, `invalid_input`) are shown inline.

## Agents (`agents/`)

**Dynamic seller agents.** A seller-bound event for a seller with no static agent (not in the principals file)
is handled like this:
- If `route.seller_delegated === false`, the event is acked and skipped.
- Otherwise the worker token mints a seller token (`POST /worker/sellers/:id/token`). A `SellerAgent` is built
  and cached, minted again 10 minutes before expiry or on a 401, and given its own Inkbox identity.

**Local delivery fallback:**
- `INKBOX_LOCAL_SELLERS` (comma-separated seller names or IDs, case-insensitive) always uses in-process
  delivery.
- If the identity cap is reached, the runner warns once and falls back to in-process delivery for that agent.
  It doesn't crash.

**`order.confirmed` → sale email:** the seller agent reads `get_business` over MCP for `owner_email`, then
emails "Sold: <title>, <total>" once, with Idempotency-Key `exchangent-sale-<order_id>`:
- from the seller's own Inkbox identity when it has one;
- otherwise from the buyer agent's identity as the platform mailbox;
- with local transport, a log line only.
