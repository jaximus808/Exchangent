import Stripe from 'stripe';
import { createAdminClient } from '@insforge/sdk';

export class CommerceError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export function assertTestKey(key) {
  if (!/^(?:sk|rk|rkcs)_test_/.test(key ?? '')) throw new CommerceError('test_key_required', 500);
}
export function validateSession(session, reservation) {
  if (session.livemode !== false || !session.id?.startsWith('cs_test_') || session.mode !== 'payment')
    throw new CommerceError('test_session_required');
  if (session.id !== reservation.stripe_session_id || session.client_reference_id !== reservation.id ||
      session.metadata?.reservation_id !== reservation.id) throw new CommerceError('session_mismatch');
  if (session.amount_total !== reservation.total_cents || session.currency !== reservation.currency)
    throw new CommerceError('payment_mismatch');
}
const handled = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'checkout.session.expired']);
export class Commerce {
  constructor({ db, stripe, webhookSecret, baseUrl, integrationId }) {
    this.db=db; this.stripe=stripe; this.webhookSecret=webhookSecret;
    this.baseUrl=baseUrl; this.integrationId=integrationId;
  }
  async rpc(name, args) {
    const {data,error}=await this.db.database.rpc(name,args);
    if(error) throw new CommerceError(error.message ?? 'database_error');
    return data;
  }
  async row(table,id) {
    const {data,error}=await this.db.database.from(table).select('*').eq('id',id).limit(1);
    if(error) throw new CommerceError('database_error',503);
    if(!data?.length) throw new CommerceError('not_found',404);
    return data[0];
  }
  reserve(buyer,offer,key) {
    if(typeof key!=='string'||key.length<1||key.length>200) throw new CommerceError('idempotency_key_required',400);
    return this.rpc('commerce_reserve',{p_buyer:buyer,p_offer:offer,p_key:key});
  }
  async checkout(buyer,id) {
    const r=await this.rpc('commerce_begin_checkout',{p_buyer:buyer,p_reservation:id});
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
  async webhook(raw,signature) {
    let event;
    try {event=this.stripe.webhooks.constructEvent(raw,signature,this.webhookSecret);}
    catch {throw new CommerceError('invalid_signature',400);}
    if(event.livemode!==false) throw new CommerceError('live_event_rejected',400);
    if(!handled.has(event.type)) return {ignored:true};
    // Refetch authoritative state: a delayed/old event cannot roll a paid order back.
    const session=await this.stripe.checkout.sessions.retrieve(event.data.object.id);
    const id=session.metadata?.reservation_id;
    if(!id) throw new CommerceError('reservation_binding_missing',400);
    const r=await this.row('commerce_reservations',id);
    validateSession(session,r);
    return this.rpc('commerce_apply_payment',{
      p_event:event.id,p_type:event.type,p_reservation:r.id,p_session:session.id,
      p_total:session.amount_total,p_currency:session.currency,
      p_paid:session.payment_status==='paid',
      p_release:session.status==='expired' || (event.type==='checkout.session.async_payment_failed' && session.payment_status==='unpaid'),
      p_pending:session.status==='complete' && session.payment_status==='unpaid',
    });
  }
  async status(buyer,id) {
    const r=await this.row('commerce_reservations',id);
    if(r.buyer_id!==buyer) throw new CommerceError('forbidden',403);
    const {data,error}=await this.db.database.from('commerce_orders')
      .select('id,status,total_cents,currency,created_at').eq('reservation_id',id).limit(1);
    if(error) throw new CommerceError('database_error',503);
    return {reservation_id:r.id,status:r.status,total_cents:r.total_cents,currency:r.currency,order:data?.[0]??null};
  }
}
export function fromEnv(env=process.env) {
  assertTestKey(env.STRIPE_SECRET_KEY);
  for(const key of ['INSFORGE_URL','INSFORGE_API_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_INTEGRATION_ID'])
    if(!env[key]) throw new CommerceError(`missing_${key}`,500);
  const baseUrl=env.COMMERCE_BASE_URL??'http://127.0.0.1:8787';
  const url=new URL(baseUrl);
  if(url.protocol!=='https:' && !['127.0.0.1','localhost'].includes(url.hostname)) throw new CommerceError('https_required',500);
  return new Commerce({db:createAdminClient({baseUrl:env.INSFORGE_URL,apiKey:env.INSFORGE_API_KEY}),
    stripe:new Stripe(env.STRIPE_SECRET_KEY),webhookSecret:env.STRIPE_WEBHOOK_SECRET,
    baseUrl,integrationId:env.STRIPE_INTEGRATION_ID});
}
