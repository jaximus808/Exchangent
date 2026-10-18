// Shared backend types. Row and RPC shapes mirror migrations/*.sql; HTTP and JSON
// input stays `unknown` until a validator narrows it. Type-only: erased at runtime.

// ---------- Errors and HTTP envelopes ----------
export type KnownErrorCode =
 // Auth and access
 | 'unauthorized' | 'forbidden' | 'user_session_required' | 'authentication_unavailable'
 | 'invalid_delegation' | 'invalid_scope' | 'delegation_failed'
 // Connector OAuth consent API (src/oauth.ts)
 | 'invalid_client' | 'invalid_redirect_uri' | 'invalid_request'
 // Input
 | 'invalid_id' | 'invalid_input' | 'invalid_json' | 'idempotency_key_required' | 'idempotency_conflict' | 'body_too_large'
 // Lookups
 | 'not_found' | 'session_not_found' | 'request_not_found' | 'offer_not_found' | 'reservation_not_found'
 | 'event_not_found' | 'seller_not_found'
 // Negotiation and reservation rules (raised by SQL functions)
 | 'stale_offer' | 'not_your_turn' | 'session_closed' | 'below_floor' | 'out_of_stock' | 'budget_exceeded'
 | 'requirements_mismatch' | 'offer_expired' | 'seller_disabled' | 'request_already_reserved'
 | 'reservation_expired' | 'reservation_not_payable' | 'payment_pending' | 'session_conflict'
 // Payments
 | 'test_key_required' | 'test_session_required' | 'session_mismatch' | 'payment_mismatch' | 'invalid_signature'
 | 'live_event_rejected' | 'reservation_binding_missing'
 // Configuration and fallbacks
 | 'missing_anon_key' | 'https_required' | 'configuration_error' | 'database_error' | 'operation_failed';
/** Known codes, `missing_<ENV_VAR>`, or a snake_case code raised by a SQL function. */
export type ErrorCode = KnownErrorCode | `missing_${string}` | (string & {});

export interface ApiError { code: string; message: string; next_action: string }
export type ApiEnvelope<T> = { data: T } | { error: ApiError };

// ---------- Database client surface ----------
// The subset of the InsForge admin client (@insforge/sdk, PostgREST) the backend uses.
// scripts/pg-db.ts implements the same interface over a direct Postgres connection.
export type Row = Record<string, unknown>;
export interface DbError { message: string; code?: string }
export interface DbResult<T = unknown> { data: T | null; error: DbError | null }
/** Awaiting a read without limit() returns every matching row, like the PostgREST builder. */
export interface DbRead<T = Row> extends PromiseLike<DbResult<T[]>> {
 eq(column: string, value: unknown): this;
 order(column: string, options?: { ascending?: boolean }): this;
 limit(count: number): PromiseLike<DbResult<T[]>>;
}
export interface DbUpdate extends PromiseLike<DbResult> { eq(column: string, value: unknown): this }
export interface DbInsert extends PromiseLike<DbResult> { select(columns: string): PromiseLike<DbResult<Row[]>> }
export interface DbTable {
 select(columns: string): DbRead;
 insert(rows: Row[]): DbInsert;
 upsert(rows: Row[], options?: { onConflict?: string }): PromiseLike<DbResult>;
 update(values: Row): DbUpdate;
 delete(): { like(column: string, pattern: string): PromiseLike<DbResult> };
}
export interface Db {
 database: {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<DbResult>;
  from(table: string): DbTable;
 };
}
/** Negotiation needs only RPCs. */
export interface RpcDb { database: Pick<Db['database'], 'rpc'> }

// ---------- Principals ----------
export type DelegationScope = 'request:read' | 'reservation:write' | 'checkout:write' | 'seller:read';
/** Verified InsForge user session (src/auth.ts). Optional fields keep `principal.scopes ?? null` uniform. */
export interface UserPrincipal {
 kind: 'user'; actorId: string; userId: string;
 /** Email of the verified InsForge user, when InsForge returned one. */
 email?: string;
 scopes?: undefined; requestId?: undefined; sellerId?: undefined;
}
/** Opaque `exg_` task delegation bound to one request or one seller. */
export interface DelegationPrincipal {
 kind: 'delegation'; actorId: string; delegationId: string;
 requestId: string | null; sellerId: string | null; scopes: DelegationScope[];
}
export type Principal = UserPrincipal | DelegationPrincipal;

/**
 * Negotiation-route principal: a seeded 64-hex role token (commerce_resolve_principal) or an
 * `exc_` connector access token from the OAuth flow (commerce_resolve_connector, kind 'connector').
 * `buyer_agent` is the platform buyer agent (scripts/agent-tokens.ts): it acts as the buyer of
 * any request with delegate_negotiation on, for reads, counters and declines only.
 */
export type RoleScope = 'buyer' | 'buyer_agent' | 'seller' | 'worker';
export interface RolePrincipal {
 scope: RoleScope; actor_id: string; seller_id?: string | null; label?: string;
 kind?: 'connector'; client_id?: string;
}

// ---------- Table rows (subset of columns the backend reads) ----------
export type RequestStatus = 'negotiating' | 'awaiting_payment' | 'confirmed';
export type ReservationStatus = 'held' | 'checkout_open' | 'payment_pending' | 'consumed' | 'expired' | 'failed';
export interface RequestRow {
 id: string; buyer_id: string; budget_cents: number; currency: string; status: RequestStatus;
 requirements: string; created_at: string;
}
export interface SellerRow { id: string; owner_id: string; name: string; enabled: boolean }
export interface OfferRow {
 id: string; request_id: string; seller_id: string; version: number; delivery_cents: number; tax_cents: number;
 expires_at: string; is_current: boolean;
}
export interface OfferItemRow { inventory_id: string; quantity: number; unit_cents: number }
export interface ReservationRow {
 id: string; request_id: string; buyer_id: string; offer_id: string; seller_id: string; offer_version: number;
 idempotency_key: string; total_cents: number; currency: string; status: ReservationStatus; expires_at: string;
 checkout_expires_at: number | null; stripe_session_id: string | null; checkout_url: string | null; created_at: string;
}
export interface OrderSummary { id: string; status: 'confirmed'; total_cents: number; currency: string; created_at: string }
export interface DelegationRow {
 id: string; actor_id: string; request_id: string | null; seller_id: string | null; scopes: DelegationScope[];
 expires_at: string; revoked_at: string | null;
}
export interface PaymentResult { duplicate: boolean; order_id?: string | null; confirmed?: boolean }

// ---------- Negotiation RPC shapes (unredacted; the server projects per role) ----------
export type SessionStatus = 'open' | 'declined' | 'closed';
export type Turn = 'seller' | 'buyer';
export interface RequirementItem { category: string; quantity?: number; [attribute: string]: unknown }
export interface Requirements { region?: string | null; deliver_by?: string; items: RequirementItem[]; [key: string]: unknown }
export interface OfferItemJson {
 inventory_id: string; sku: string; title: string; category: string | null; attributes: Record<string, unknown>;
 quantity: number; unit_cents: number; list_cents: number | null; floor_cents: number;
}
export interface OfferJson {
 offer_id: string; session_id: string; seller_id: string; version: number; session_version: number; is_current: boolean;
 subtotal_cents: number; delivery_cents: number; tax_cents: number; total_cents: number; currency: 'usd';
 note: string | null; expires_at: string; created_at: string; items: OfferItemJson[];
}
export interface CounterJson {
 counter_id: string; session_id: string; responding_to_offer_id: string; total_cents: number; note: string | null;
 version: number; created_at: string;
}
export interface SessionJson {
 session_id: string; request_id: string; seller_id: string; seller_name: string;
 seller: { service_area: string; delivery_cents: number; delivery_days: number; agent_handle: string | null };
 status: SessionStatus; turn: Turn; version: number; rounds: number;
 declined_by: Turn | null; decline_reason: string | null; created_at: string; updated_at: string;
 current_offer: OfferJson | null; latest_counter: CounterJson | null;
}
export interface RequestJson {
 request_id: string; buyer_id: string; title: string | null; status: RequestStatus; requirements: Requirements;
 budget_cents: number; target_cents: number | null; currency: string; deadline: string | null;
 delegate_negotiation: boolean; created_at: string;
}
export interface RequestState extends RequestJson {
 sessions: SessionJson[];
 reservation: {
  reservation_id: string; offer_id: string; seller_id: string; status: ReservationStatus; total_cents: number;
  expires_at: string; checkout_url: string | null;
 } | null;
}
export type HistoryEntry = ({ type: 'offer' } & OfferJson) | ({ type: 'counter' } & CounterJson);
export interface SessionState extends SessionJson { request: RequestJson; history: HistoryEntry[] }
export interface SellerSession extends SessionJson {
 request: Pick<RequestJson, 'request_id' | 'title' | 'status' | 'requirements' | 'deadline' | 'created_at'>;
}
export interface InventoryItem {
 inventory_id: string; sku: string; title: string; category: string | null; attributes: Record<string, unknown>;
 list_cents: number | null; floor_cents: number; available: number; sold: number;
}
export interface CreatedRequest { request_id: string; status: RequestStatus; sessions: { session_id: string; seller_id: string; seller_name: string }[] }
export interface CreatedOffer { offer_id: string; version: number; total_cents: number; session_version: number }
export interface CreatedCounter { counter_id: string; session_version: number }
export interface DeclinedSession { session_id: string; status: SessionStatus; session_version: number }
/** commerce_delegated_buyer: the buyer a buyer_agent principal acts for. */
export interface DelegatedBuyer { request_id: string; buyer_id: string }
/** commerce_delegated_buyer_email: the buyer's InsForge email (buyer agent only); null for demo actors. */
export interface DelegatedBuyerEmail { request_id: string; email: string | null }

// ---------- Outbox (worker feed) ----------
export type OutboxKind = 'session.opened' | 'offer.created' | 'counter.created' | 'session.declined';
export interface OutboxPayloads {
 'session.opened': { session_id: string; request_id: string };
 'offer.created': { session_id: string; request_id: string; offer_id: string; total_cents: number; note: string | null };
 'counter.created': { session_id: string; counter_id: string; total_cents: number; note: string | null };
 'session.declined': { session_id: string };
}
export type WorkerEvent = { [K in OutboxKind]: {
 id: string; kind: K; created_at: string; payload: OutboxPayloads[K];
 route: { to_role: Turn; request_id?: string; seller_id?: string; buyer_id?: string; agent_handle?: string;
  /** The request's delegate_negotiation: the platform buyer agent negotiates it. */
  delegated: boolean };
} }[OutboxKind];
export interface EventAck { id: string; kind: OutboxKind; delivered_at: string }
export interface AgentHandle { seller_id: string; agent_handle: string }
