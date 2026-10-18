// Order lifecycle, agent-negotiated remedies and refunds (doc/resolution-contract.md, migration 0900).
// The SQL functions decide everything (who may act, what is refundable, which automatic rule applies); this
// module checks scopes, validates input shapes, and executes the refunds the database decided through Stripe
// (idempotency key exchangent-refund-<refund_id>) before recording the result.
import type Stripe from 'stripe';
import { CommerceError } from './commerce.ts';
import type { Commerce } from './commerce.ts';
import { MESSAGES, NEXT_ACTIONS, buyerView, fail, id, sellerView } from './negotiation.ts';
import type { Negotiation } from './negotiation.ts';
import type { DbError, ErrorCode, RolePrincipal } from './types.ts';

// Statuses and hints for the codes migration 0900 raises (other codes keep negotiation.ts's mapping).
const STATUS: Record<string,number>={order_not_found:404,case_not_found:404,refund_not_found:404,dispute_not_found:404,
 item_not_in_order:400,test_mode_only:403,refund_failed:502};
Object.assign(NEXT_ACTIONS,{
 order_not_found:'Check the order ID. Buyers: call list_my_orders; sellers: call list_orders.',
 case_not_found:'Check the case ID returned by open_case, list_cases or get_order.',
 refund_not_found:'Check the refund ID from get_order or get_case.',
 item_not_in_order:'Use inventory_id values from the order items (get_order).',
 order_closed:'This order is cancelled or fully refunded; there is nothing left to resolve.',
 case_already_open:'This order already has an open case. Call get_order, then get_case and respond to it.',
 case_closed:'This case is no longer open. Call get_case to see how it was resolved.',
 stale_case:'The case moved on. Call get_case and respond to the latest version.',
 nothing_to_accept:'There is no remedy from the other side to accept. Propose one with action counter.',
 already_shipped:'The order has shipped, so it can no longer be cancelled. Propose a return or a refund instead.',
 order_not_shippable:'Only a paid order that has not shipped can be marked shipped (or reported out of stock).',
 order_not_shipped:'The order has not shipped yet. The seller marks it shipped first.',
 no_return_expected:'Only a case resolved with return_for_refund expects a return.',
 price_increase_not_allowed:'A substitute can never cost more than the buyer paid. Offer it at or below the original price.',
 test_mode_only:'Simulated deliveries exist only in Stripe test mode.',
 refund_failed:'The case is resolved but the refund did not go through. Retry with POST /refunds/<refund_id>/retry.',
} satisfies Partial<Record<ErrorCode,string>>);
Object.assign(MESSAGES,{case_already_open:'This order already has an open case.',stale_case:'expected_version does not match the case version.',
 order_closed:'The order is cancelled or fully refunded.',refund_failed:'The refund could not be completed.'});

const isObject=(v: unknown): v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function body(value: unknown): Record<string,unknown> {
 if(value==null) return {};
 if(!isObject(value)) throw fail('invalid_input','Body must be a JSON object');
 return value;
}
function text(value: unknown,name: string,max: number,optional=true): string | null {
 if(value==null&&optional) return null;
 if(typeof value!=='string'||!value.trim()||value.length>max) throw fail('invalid_input',`${name} must be a string of 1-${max} characters`);
 return value;
}
function key(value: unknown): string | null {
 if(value==null) return null;
 if(typeof value!=='string'||value.length<1||value.length>200) throw fail('idempotency_key_required');
 return value;
}
const jsonOrNull=(value: unknown,name: string,kind: 'object'|'array'|'any'='any')=>{
 if(value==null) return null;
 if(kind==='object'&&!isObject(value)) throw fail('invalid_input',`${name} must be an object`);
 if(kind==='array'&&!Array.isArray(value)) throw fail('invalid_input',`${name} must be an array`);
 return value;
};

export interface RefundToExecute { refund_id: string; amount_cents: number }
interface RefundTarget {
 refund_id: string; order_id: string; amount_cents: number; status: 'pending'|'succeeded'|'failed'; stripe_refund_id: string | null;
 payment_intent: string | null; stripe_session_id: string; buyer_id: string; seller_id: string;
}
export interface CaseResult extends Record<string,unknown> { case_id: string; refunds_to_execute?: RefundToExecute[]; policy?: unknown }

/** Who the principal is to the database: (actor, scope, seller). The buyer agent keeps its own scope (SQL checks delegation). */
function who(p: RolePrincipal) { return {p_actor:p.actor_id,p_scope:p.scope,p_seller:p.seller_id??null}; }

/** Simulated carrier scans are a test-mode convenience only. */
export function testMode(env: NodeJS.ProcessEnv=process.env) {
 const k=env.STRIPE_SECRET_KEY;
 return !k||/^(?:sk|rk|rkcs)_test_/.test(k);
}

export class Resolution {
 negotiation: Negotiation; commerce: Commerce;
 constructor({negotiation,commerce}: {negotiation: Negotiation; commerce: Commerce}) {this.negotiation=negotiation;this.commerce=commerce;}
 async rpc<T=unknown>(name: string,args: Record<string,unknown>): Promise<T> {
  const {data,error}=await this.commerce.db.database.rpc(name,args);
  if(error) {
   const message=(error as DbError).message??'';
   if(/^[a-z_]+$/.test(message)) throw STATUS[message]?new CommerceError(message,STATUS[message]):fail(message);
   throw fail('database_error');
  }
  return data as T;
 }
 /** Buyer-side views never see the seller's resolution policy (its auto-approve limit works like a floor). */
 view(role: 'buyer'|'seller',x: Record<string,unknown>) {
  if(role==='seller') return sellerView(x);
  const {policy:_policy,...rest}=x;
  return buyerView(rest);
 }

 // ---------- refunds ----------
 async paymentIntent(t: RefundTarget): Promise<string> {
  if(t.payment_intent) return t.payment_intent;
  // Orders paid before migration 0800 stored no PaymentIntent: read it from the bound test Checkout Session.
  if(!t.stripe_session_id?.startsWith('cs_test_')) throw new CommerceError('test_session_required');
  const session=await this.commerce.stripe.checkout.sessions.retrieve(t.stripe_session_id);
  const pi=typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id;
  if(!pi) throw new CommerceError('refund_failed',502);
  await this.rpc('commerce_set_payment_intent',{p_order:t.order_id,p_payment_intent:pi});
  return pi;
 }
 /** Execute decided refunds through Stripe, record each result. Throws refund_failed (502) after recording a failure. */
 async execute(refunds: RefundToExecute[] | undefined) {
  let failed=false;
  for(const {refund_id} of refunds??[]) {
   const t=await this.rpc<RefundTarget | null>('commerce_refund_target',{p_refund:refund_id});
   if(!t||t.status==='succeeded') continue;
   try {
    const pi=await this.paymentIntent(t);
    const refund=await this.commerce.stripe.refunds.create({payment_intent:pi,amount:t.amount_cents,
     metadata:{refund_id:t.refund_id,order_id:t.order_id}},{idempotencyKey:`exchangent-refund-${t.refund_id}`});
    const status=refund.status==='succeeded'?'succeeded':refund.status==='failed'||refund.status==='canceled'?'failed':'pending';
    await this.rpc('commerce_refund_result',{p_refund:t.refund_id,p_status:status,p_stripe_id:refund.id});
    if(status==='failed') failed=true;
   } catch(error) {
    console.error(`refund failed refund=${t.refund_id} reason=${error instanceof CommerceError?error.code:(error as {type?: string}).type??'error'}`);
    await this.rpc('commerce_refund_result',{p_refund:t.refund_id,p_status:'failed',p_stripe_id:null});
    failed=true;
   }
  }
  if(failed) throw new CommerceError('refund_failed',502);
 }
 /** Run the money part of a case result, then return the case for this viewer. */
 async settle(role: 'buyer'|'seller',result: CaseResult) {
  const {refunds_to_execute,...rest}=result;
  if(refunds_to_execute?.length) {
   await this.execute(refunds_to_execute);
   return this.view(role,await this.rpc<Record<string,unknown>>('commerce_case_json',{p_case:result.case_id}));
  }
  return this.view(role,rest);
 }
 roleOf(p: RolePrincipal): 'buyer'|'seller' { return p.scope==='seller'?'seller':'buyer'; }

 // ---------- buyer ----------
 async buyerOrders(p: RolePrincipal) {
  this.negotiation.need(p,'buyer');
  return buyerView(await this.rpc<unknown[]>('commerce_buyer_orders',{p_buyer:p.actor_id}));
 }
 async getOrder(p: RolePrincipal,orderId: unknown) {
  this.negotiation.need(p,'buyer','buyer_agent','seller');
  const order=id(orderId);
  const role=await this.rpc<'buyer'|'seller'>('commerce_order_role',{p_order:order,...who(p)});
  const json=await this.rpc<Record<string,unknown>>('commerce_order_json',{p_order:order});
  return role==='seller'?sellerView({...json,shipping_name:'Buyer'}):buyerView(json);
 }
 async confirmReceived(p: RolePrincipal,orderId: unknown) {
  this.negotiation.need(p,'buyer');
  return buyerView(await this.rpc('commerce_mark_delivered',{p_order:id(orderId),...who(p),p_source:'buyer_confirmed'}));
 }
 async openCase(p: RolePrincipal,orderId: unknown,idempotencyKey: unknown,input: unknown) {
  this.negotiation.need(p,'buyer');
  const b=body(input);
  const result=await this.rpc<CaseResult>('commerce_open_case',{p_actor:p.actor_id,p_scope:'buyer',p_order:id(orderId),
   p_type:text(b.type,'type',40,false),p_items:jsonOrNull(b.items,'items','array'),p_description:text(b.description,'description',1000),
   p_evidence:jsonOrNull(b.evidence,'evidence'),p_requested_remedy:jsonOrNull(b.requested_remedy,'requested_remedy','object'),
   p_key:key(idempotencyKey)});
  return this.settle('buyer',result);
 }

 // ---------- either party ----------
 async getCase(p: RolePrincipal,caseId: unknown) {
  this.negotiation.need(p,'buyer','buyer_agent','seller');
  const c=id(caseId);
  const role=await this.rpc<'buyer'|'seller'>('commerce_case_role',{p_case:c,...who(p)});
  return this.view(role,await this.rpc<Record<string,unknown>>('commerce_case_json',{p_case:c}));
 }
 async respond(p: RolePrincipal,caseId: unknown,idempotencyKey: unknown,input: unknown) {
  this.negotiation.need(p,'buyer','buyer_agent','seller');
  const b=body(input);
  if(typeof b.expected_version!=='number'||!Number.isInteger(b.expected_version)) throw fail('invalid_input','expected_version must be an integer');
  const result=await this.rpc<CaseResult>('commerce_respond_case',{...who(p),p_case:id(caseId),p_expected_version:b.expected_version,
   p_action:text(b.action,'action',20,false),p_remedy:jsonOrNull(b.remedy,'remedy','object'),p_note:text(b.note,'note',500),
   p_key:key(idempotencyKey)});
  return this.settle(this.roleOf(p),result);
 }
 async addEvidence(p: RolePrincipal,caseId: unknown,idempotencyKey: unknown,input: unknown) {
  this.negotiation.need(p,'buyer','buyer_agent','seller');
  const b=body(input);
  const evidence=b.evidence??(b.kind!=null?{kind:b.kind,ref:b.ref}:null);
  if(evidence==null) throw fail('invalid_input','Send evidence: {kind, ref} or a list of them');
  return this.view(this.roleOf(p),await this.rpc<Record<string,unknown>>('commerce_add_evidence',{...who(p),p_case:id(caseId),
   p_evidence:evidence,p_key:key(idempotencyKey)}));
 }
 /** Retry a refund that failed (or never reached Stripe). Either party to the order; Stripe's idempotency key makes it safe. */
 async retryRefund(p: RolePrincipal,refundId: unknown) {
  this.negotiation.need(p,'buyer','seller');
  const t=await this.rpc<RefundTarget | null>('commerce_refund_target',{p_refund:id(refundId)});
  if(!t) throw new CommerceError('refund_not_found',404);
  await this.rpc('commerce_order_role',{p_order:t.order_id,...who(p)});
  if(t.status!=='succeeded') await this.execute([{refund_id:t.refund_id,amount_cents:t.amount_cents}]);
  return (await this.rpc<RefundTarget>('commerce_refund_target',{p_refund:t.refund_id})).status==='succeeded'
   ?{refund_id:t.refund_id,status:'succeeded'}:{refund_id:t.refund_id,status:'pending'};
 }

 // ---------- seller ----------
 async sellerOrders(p: RolePrincipal) {
  this.negotiation.need(p,'seller');
  return sellerView(await this.rpc<unknown[]>('commerce_seller_orders',{p_seller:p.seller_id}));
 }
 async sellerCases(p: RolePrincipal) {
  this.negotiation.need(p,'seller');
  return sellerView(await this.rpc<unknown[]>('commerce_cases_for',{p_actor:null,p_scope:'seller',p_seller:p.seller_id}));
 }
 /** Physical-world facts (shipped, delivered, returned, out of stock) and the policy come from the owner, never an agent token. */
 async ship(p: RolePrincipal,orderId: unknown,input: unknown) {
  this.negotiation.ownerOnly(p);
  const b=body(input);
  return sellerView(await this.rpc<Record<string,unknown>>('commerce_mark_shipped',{p_seller:p.seller_id,p_order:id(orderId),
   p_carrier:text(b.carrier,'carrier',80,false),p_tracking:text(b.tracking,'tracking',120,false)}));
 }
 async simulateDelivery(p: RolePrincipal,orderId: unknown) {
  this.negotiation.ownerOnly(p);
  if(!testMode()) throw new CommerceError('test_mode_only',403);
  const order=await this.rpc<Record<string,unknown>>('commerce_mark_delivered',{p_order:id(orderId),...who(p),p_source:'simulated'});
  return {...sellerView(order),simulated:true};
 }
 async reportIssue(p: RolePrincipal,orderId: unknown,idempotencyKey: unknown,input: unknown) {
  this.negotiation.ownerOnly(p);
  const b=body(input);
  const result=await this.rpc<CaseResult>('commerce_report_fulfilment_issue',{p_seller:p.seller_id,p_order:id(orderId),
   p_kind:text(b.kind,'kind',40,false),p_items:jsonOrNull(b.items,'items','array'),p_substitute:jsonOrNull(b.substitute,'substitute','object'),
   p_note:text(b.note,'note',500),p_key:key(idempotencyKey)});
  return this.settle('seller',result);
 }
 async returnReceived(p: RolePrincipal,caseId: unknown,idempotencyKey: unknown) {
  this.negotiation.ownerOnly(p);
  return this.settle('seller',await this.rpc<CaseResult>('commerce_confirm_return',{p_seller:p.seller_id,p_case:id(caseId),
   p_key:key(idempotencyKey)}));
 }
 async getPolicy(p: RolePrincipal) {
  this.negotiation.need(p,'seller');
  return this.rpc('commerce_get_policy',{p_seller:p.seller_id});
 }
 async setPolicy(p: RolePrincipal,input: unknown) {
  this.negotiation.ownerOnly(p);
  return this.rpc('commerce_set_policy',{p_seller:p.seller_id,p_patch:body(input)});
 }

 // ---------- web dashboard (InsForge user session; the caller checked ownership) ----------
 userOrders(actorId: string) { return this.rpc<unknown[]>('commerce_buyer_orders',{p_buyer:actorId}).then(buyerView); }
 businessOrders(sellerId: string) { return this.rpc<unknown[]>('commerce_seller_orders',{p_seller:sellerId}).then(sellerView); }
 businessCases(sellerId: string) {
  return this.rpc<unknown[]>('commerce_cases_for',{p_actor:null,p_scope:'seller',p_seller:sellerId}).then(sellerView);
 }

 // ---------- worker ----------
 /** "Email your agent": the delegated requests of the account with exactly this email (status summary only). */
 async buyerRequestsByEmail(p: RolePrincipal,email: string | null) {
  this.negotiation.need(p,'worker');
  if(!email||email.length>320||!email.includes('@')) throw fail('invalid_input','email is required');
  return this.rpc<unknown[]>('commerce_buyer_requests_by_email',{p_email:email});
 }
 /** Owner notices (case and dispute emails) for any business, including owners who negotiate by hand. */
 async sellerOwner(p: RolePrincipal,sellerId: unknown) {
  this.negotiation.need(p,'worker');
  return this.rpc<{seller_id: string; name: string; owner_email: string | null}>('commerce_seller_owner',{p_seller:id(sellerId)});
 }
 async sweep(p: RolePrincipal) {
  this.negotiation.need(p,'worker');
  return this.rpc('commerce_resolution_sweep',{});
 }
 /** Resolution events for runners that opted in (?include=resolution); merged into the worker feed. */
 async events(limit: number) {
  try {return await this.rpc<{created_at: string; id: string}[]>('commerce_resolution_events',{p_limit:limit});}
  catch(error) {
   // Before migration 0900 the function does not exist: the negotiation feed must keep working.
   if(error instanceof CommerceError&&error.code==='database_error') return [];
   throw error;
  }
 }
 async ack(eventId: string,delivery?: unknown) {
  return this.rpc('commerce_ack_resolution_event',{p_event:eventId,...(delivery!=null?{p_delivery:delivery}:{})});
 }
}

/**
 * Web dashboard routes on an InsForge user session (server.ts). A buyer acts as themselves; an owner acts as
 * their business after `ownBusiness` checked ownership. Same Resolution methods (and SQL checks) as the role
 * and connector routes. Returns undefined when the path is not one of these routes.
 */
export async function userResolutionRoute(r: Resolution,{actor,method,path,key,input,ownBusiness}: {
 actor: ()=>string; method: string | undefined; path: string; key: unknown; input: ()=>Promise<Record<string,unknown>>;
 ownBusiness: (sellerId: string)=>Promise<unknown>;
}): Promise<unknown> {
 // Matched routes only: other paths keep their own auth (delegations included).
 if(method==='GET'&&path==='/api/v1/orders') return r.userOrders(actor());
 const buyer=(): RolePrincipal=>({scope:'buyer',actor_id:actor(),seller_id:null,label:'user'});
 let m=path.match(/^\/api\/v1\/orders\/([^/]+)(?:\/(received|cases))?$/);
 if(m&&!(method==='GET'&&m[2])&&!(method==='POST'&&!m[2])) {
  if(method==='GET'&&!m[2]) return r.getOrder(buyer(),m[1]);
  if(method==='POST'&&m[2]==='received') return r.confirmReceived(buyer(),m[1]);
  if(method==='POST'&&m[2]==='cases') return r.openCase(buyer(),m[1],key,await input());
 }
 m=path.match(/^\/api\/v1\/cases\/([^/]+)(?:\/(respond|evidence))?$/);
 if(m) {
  if(method==='GET'&&!m[2]) return r.getCase(buyer(),m[1]);
  if(method==='POST'&&m[2]==='respond') return r.respond(buyer(),m[1],key,await input());
  if(method==='POST'&&m[2]==='evidence') return r.addEvidence(buyer(),m[1],key,await input());
 }
 m=path.match(/^\/api\/v1\/businesses\/([^/]+)\/(orders|cases|policy)(?:\/([^/]+)\/(ship|simulate-delivery|respond|return-received|evidence))?$/);
 if(!m) return undefined;
 const [,sellerId,kind,sub,action]=m;
 const routed=(kind==='orders'&&((method==='GET'&&!sub)||(method==='POST'&&['ship','simulate-delivery'].includes(action))))
  ||(kind==='cases'&&((method==='GET'&&!sub)||(method==='POST'&&['respond','return-received','evidence'].includes(action))))
  ||(kind==='policy'&&!sub&&(method==='GET'||method==='PUT'));
 if(!routed) return undefined;
 await ownBusiness(sellerId);
 const seller: RolePrincipal={scope:'seller',actor_id:actor(),seller_id:sellerId,label:'user'};
 if(kind==='orders') {
  if(!sub) return r.businessOrders(sellerId);
  return action==='ship'?r.ship(seller,sub,await input()):r.simulateDelivery(seller,sub);
 }
 if(kind==='cases') {
  if(!sub) return r.businessCases(sellerId);
  if(action==='respond') return r.respond(seller,sub,key,await input());
  if(action==='evidence') return r.addEvidence(seller,sub,key,await input());
  return r.returnReceived(seller,sub,key);
 }
 return method==='GET'?r.getPolicy(seller):r.setPolicy(seller,await input());
}

export type { Stripe };
