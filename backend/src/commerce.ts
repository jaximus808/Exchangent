import Stripe from 'stripe';
import { createAdminClient } from '@insforge/sdk';
import type { InsForgeClient } from '@insforge/sdk';
import type { Db, DbTable, ErrorCode, OrderSummary, PaymentResult, ReservationRow } from './types.ts';

export class CommerceError extends Error {
  code: ErrorCode; status: number;
  declare detail?: string;
  constructor(code: ErrorCode, status = 409) { super(code); this.code = code; this.status = status; }
}
export function assertTestKey(key: string | undefined) {
  if (!/^(?:sk|rk|rkcs)_test_/.test(key ?? '')) throw new CommerceError('test_key_required', 500);
}
/** The Checkout Session fields that bind a payment to a reservation. */
export interface SessionFacts {
  id?: string; livemode?: boolean; mode?: string; client_reference_id?: string | null;
  metadata?: Partial<Record<string, string>> | null; amount_total?: number | null; currency?: string | null;
}
export function validateSession(session: SessionFacts, reservation: Pick<ReservationRow, 'id' | 'stripe_session_id' | 'total_cents' | 'currency'>) {
  if (session.livemode !== false || !session.id?.startsWith('cs_test_') || session.mode !== 'payment')
    throw new CommerceError('test_session_required');
  if (session.id !== reservation.stripe_session_id || session.client_reference_id !== reservation.id ||
      session.metadata?.reservation_id !== reservation.id) throw new CommerceError('session_mismatch');
  if (session.amount_total !== reservation.total_cents || session.currency !== reservation.currency)
    throw new CommerceError('payment_mismatch');
}
type CheckoutEvent = Stripe.CheckoutSessionCompletedEvent | Stripe.CheckoutSessionAsyncPaymentSucceededEvent |
  Stripe.CheckoutSessionAsyncPaymentFailedEvent | Stripe.CheckoutSessionExpiredEvent;
const handled = new Set<string>(['checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired']);
const isHandled = (event: Stripe.Event): event is CheckoutEvent => handled.has(event.type);
export interface CheckoutLink { reservation_id: string; session_id: string; url: string | null }
export interface ReservationStatusView {
  reservation_id: string; status: ReservationRow['status']; total_cents: number; currency: string; order: OrderSummary | null;
}
export interface CommerceOptions { db: Db; stripe: Stripe; webhookSecret: string; baseUrl: string; integrationId: string }
export class Commerce {
  db: Db; stripe: Stripe; webhookSecret: string; baseUrl: string; integrationId: string;
  constructor({ db, stripe, webhookSecret, baseUrl, integrationId }: CommerceOptions) {
    this.db=db; this.stripe=stripe; this.webhookSecret=webhookSecret;
    this.baseUrl=baseUrl; this.integrationId=integrationId;
  }
  // RPC results are jsonb built by our own SQL functions (migrations/); callers name the shape.
  async rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    const {data,error}=await this.db.database.rpc(name,args);
    if(error) throw new CommerceError(error.message ?? 'database_error');
    return data as T;
  }
  async row<T = Record<string, unknown>>(table: string, id: string): Promise<T> {
    const {data,error}=await this.db.database.from(table).select('*').eq('id',id).limit(1);
    if(error) throw new CommerceError('database_error',503);
    if(!data?.length) throw new CommerceError('not_found',404);
    return data[0] as T;
  }
  reserve(buyer: string, offer: string, key: unknown) {
    if(typeof key!=='string'||key.length<1||key.length>200) throw new CommerceError('idempotency_key_required',400);
    return this.rpc<ReservationRow>('commerce_reserve',{p_buyer:buyer,p_offer:offer,p_key:key});
  }
  async checkout(buyer: string, id: string): Promise<CheckoutLink> {
    const r=await this.rpc<ReservationRow>('commerce_begin_checkout',{p_buyer:buyer,p_reservation:id});
    if(r.stripe_session_id) return {reservation_id:r.id,session_id:r.stripe_session_id,url:r.checkout_url};
    // Parameters are persisted or deterministic, so concurrent/restarted calls use
    // identical parameters with the same Stripe idempotency key.
    const session=await this.stripe.checkout.sessions.create({
      mode:'payment', client_reference_id:r.id, metadata:{reservation_id:r.id},
      integration_identifier:this.integrationId,
      line_items:[{price_data:{currency:r.currency,unit_amount:r.total_cents,
        product_data:{name:'Exchangent demo desk and chair bundle',description:'Fictional goods — sandbox payment only; includes agreed demo delivery and tax.'}},quantity:1}],
      expires_at:Number(r.checkout_expires_at),
      success_url:`${this.baseUrl}/success`,cancel_url:`${this.baseUrl}/cancel`,
    },{idempotencyKey:`exchangent-checkout-${r.id}`});
    if(session.livemode!==false || !session.id.startsWith('cs_test_')) throw new CommerceError('test_session_required');
    await this.rpc('commerce_bind_checkout',{p_reservation:r.id,p_session:session.id,p_url:session.url});
    return {reservation_id:r.id,session_id:session.id,url:session.url};
  }
  async webhook(raw: string | Buffer, signature: string | string[] | undefined): Promise<PaymentResult | {ignored: true}> {
    let event: Stripe.Event;
    // A missing header fails verification inside the try, like any bad signature.
    try {event=this.stripe.webhooks.constructEvent(raw,signature as string | string[],this.webhookSecret);}
    catch {throw new CommerceError('invalid_signature',400);}
    if(event.livemode!==false) throw new CommerceError('live_event_rejected',400);
    if(!isHandled(event)) return {ignored:true};
    // Refetch authoritative state: a delayed/old event cannot roll a paid order back.
    const session=await this.stripe.checkout.sessions.retrieve(event.data.object.id);
    const id=session.metadata?.reservation_id;
    if(!id) throw new CommerceError('reservation_binding_missing',400);
    const r=await this.row<ReservationRow>('commerce_reservations',id);
    validateSession(session,r);
    return this.rpc<PaymentResult>('commerce_apply_payment',{
      p_event:event.id,p_type:event.type,p_reservation:r.id,p_session:session.id,
      p_total:session.amount_total,p_currency:session.currency,
      p_paid:session.payment_status==='paid',
      p_release:session.status==='expired' || (event.type==='checkout.session.async_payment_failed' && session.payment_status==='unpaid'),
      p_pending:session.status==='complete' && session.payment_status==='unpaid',
    });
  }
  async status(buyer: string, id: string): Promise<ReservationStatusView> {
    const r=await this.row<ReservationRow>('commerce_reservations',id);
    if(r.buyer_id!==buyer) throw new CommerceError('forbidden',403);
    const {data,error}=await this.db.database.from('commerce_orders')
      .select('id,status,total_cents,currency,created_at').eq('reservation_id',id).limit(1);
    if(error) throw new CommerceError('database_error',503);
    return {reservation_id:r.id,status:r.status,total_cents:r.total_cents,currency:r.currency,order:(data?.[0] as OrderSummary | undefined)??null};
  }
}
// The SDK's PostgREST builder parses select() column strings at the type level, so a
// structural check of Db's `select(columns: string)` overflows (TS2589). Every other
// member of Db is checked against the SDK types here; select is asserted.
type DbExceptSelect={database:{rpc: Db['database']['rpc']; from(table: string): Omit<DbTable,'select'>}};
export const asDb=(client: InsForgeClient & DbExceptSelect)=>client as unknown as Db;
export function fromEnv(env: NodeJS.ProcessEnv = process.env) {
  assertTestKey(env.STRIPE_SECRET_KEY);
  for(const key of ['INSFORGE_URL','INSFORGE_API_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_INTEGRATION_ID'])
    if(!env[key]) throw new CommerceError(`missing_${key}`,500);
  const baseUrl=env.COMMERCE_BASE_URL??'http://127.0.0.1:8787';
  const url=new URL(baseUrl);
  if(url.protocol!=='https:' && !['127.0.0.1','localhost'].includes(url.hostname)) throw new CommerceError('https_required',500);
  // Non-null assertions: each variable was checked by assertTestKey or the loop above.
  return new Commerce({db:asDb(createAdminClient({baseUrl:env.INSFORGE_URL,apiKey:env.INSFORGE_API_KEY!})),
    stripe:new Stripe(env.STRIPE_SECRET_KEY!),webhookSecret:env.STRIPE_WEBHOOK_SECRET!,
    baseUrl,integrationId:env.STRIPE_INTEGRATION_ID!});
}
