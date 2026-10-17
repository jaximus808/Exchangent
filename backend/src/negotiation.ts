import { createHash, timingSafeEqual } from 'node:crypto';
import { CommerceError } from './commerce.ts';
import type {
 AgentHandle, ApiError, CreatedCounter, CreatedOffer, CreatedRequest, DbError, DeclinedSession, ErrorCode, EventAck,
 InventoryItem, OfferJson, Requirements, RequestState, RoleScope, RolePrincipal, RpcDb, SellerSession, SessionJson,
 SessionState, WorkerEvent,
} from './types.ts';

const STATUS: Partial<Record<ErrorCode,number>>={unauthorized:401,forbidden:403,not_found:404,session_not_found:404,request_not_found:404,
 event_not_found:404,seller_not_found:404,invalid_input:400,invalid_id:400,idempotency_key_required:400,
 body_too_large:413,database_error:503};
export const statusFor=(code: ErrorCode)=>STATUS[code]??409;
export function fail(code: ErrorCode,detail?: string) {
 const e=new CommerceError(code,statusFor(code)); if(detail) e.detail=detail; return e;
}
// Only our own snake_case codes (RAISE EXCEPTION '<code>') pass through; SQL text never does.
export function dbError(error: Partial<DbError> | null | undefined) {
 const message=error?.message??'';
 return /^[a-z_]+$/.test(message)?fail(message):fail('database_error');
}
export const hashToken=(token: string)=>createHash('sha256').update(token,'utf8').digest('hex');

// Next step for an agent or human, keyed by error code. Read by the MCP layer as `next`.
export const NEXT_ACTIONS: Partial<Record<ErrorCode,string>>={
 unauthorized:'Send Authorization: Bearer <token> for a buyer, seller or worker principal.',
 forbidden:'This principal cannot act on that resource. Use IDs returned by your own list or get calls.',
 not_found:'Check the ID or path. List your requests or sessions to find valid IDs.',
 session_not_found:'Check the session ID. Buyers: call get_buy_order; sellers: call list_my_requests.',
 request_not_found:'Check the request ID, or create a new buy order.',
 offer_not_found:'Check the offer ID. Call list_offers for current offers.',
 reservation_not_found:'Check the reservation ID returned by reserve_offer.',
 event_not_found:'Check the event ID returned by GET /worker/events.',
 seller_not_found:'Check the seller ID from the event route.',
 invalid_id:'IDs are UUIDs. Use IDs returned by list or get calls.',
 invalid_input:'Fix the request body and retry with a new Idempotency-Key.',
 idempotency_key_required:'Send an Idempotency-Key header (1-200 chars) with every mutation; reuse it only to retry the same call.',
 idempotency_conflict:'That Idempotency-Key was already used with a different body. Use a new key for a new action.',
 stale_offer:'The negotiation moved on. Call get_negotiation (sellers) or get_buy_order (buyers) and respond to the latest version.',
 not_your_turn:'Wait for the other party to respond; you will be notified. Re-read the negotiation before acting.',
 session_closed:'This negotiation is closed or the request is no longer negotiating. Stop and check get_buy_order or list_my_requests.',
 below_floor:'Raise unit_cents to at least each item\'s floor_cents (see get_inventory), or decline the request.',
 out_of_stock:'Offer fewer units or other inventory (see get_inventory), or decline the request.',
 budget_exceeded:'Counter or reserve at a total at or below your budget, or decline the seller.',
 requirements_mismatch:'Offer only inventory that matches the request requirements (category and attributes) and cover every requested item. Call get_inventory and get_negotiation.',
 offer_expired:'Ask the seller for a fresh offer, or reserve another current offer from list_offers.',
 seller_disabled:'This seller is unavailable. Pick another offer from list_offers.',
 request_already_reserved:'A reservation already exists for this request. Call get_buy_order, get_reservation_status or get_checkout_link.',
 reservation_expired:'The hold expired. Reserve the current offer again with a new Idempotency-Key.',
 reservation_not_payable:'This reservation can no longer be paid. Call get_reservation_status, then reserve a current offer again.',
 payment_pending:'Payment is processing. Check get_reservation_status later.',
 body_too_large:'Send a smaller JSON body.',
 database_error:'Temporary backend problem. Retry the same call with the same Idempotency-Key.',
};
export const MESSAGES: Partial<Record<ErrorCode,string>>={
 unauthorized:'Missing or unknown bearer token.',forbidden:'Not allowed for this principal.',
 stale_offer:'expected_version does not match the current session version, or the offer was superseded.',
 not_your_turn:'It is the other party\'s turn in this negotiation.',session_closed:'The negotiation is not open.',
 below_floor:'A unit price is below that item\'s floor.',out_of_stock:'Not enough available stock.',
 budget_exceeded:'The total exceeds the buyer budget.',requirements_mismatch:'The offer does not match the request requirements.',
 idempotency_conflict:'Idempotency-Key reused with a different body.',idempotency_key_required:'Idempotency-Key header is required.',
 invalid_input:'The request body is invalid.',database_error:'The backend is temporarily unavailable.',
};
export function errorBody(error: unknown): {status: number; body: {error: ApiError}} {
 const safe=error instanceof CommerceError&&/^[a-z_]+$/.test(error.code);
 const code=safe?error.code:'operation_failed';
 return {status:error instanceof CommerceError?error.status:500,body:{error:{code,
  message:(safe&&error.detail)||MESSAGES[code]||'The operation could not be completed. Check the current reservation or retry.',
  next_action:NEXT_ACTIONS[code]??'check_status'}}};
}

// Redaction: allowlisted shapes come from SQL; these keys are additionally stripped at any depth.
const HIDDEN={buyer:['floor_cents','agent_handle','idempotency_key'],
 seller:['budget_cents','target_cents','buyer_id','agent_handle','idempotency_key'],worker:[]} as const;
/** T with keys K removed at any depth (the static shape of `strip`). */
export type Redacted<T,K extends PropertyKey>=T extends readonly (infer U)[]?Redacted<U,K>[]
 :T extends object?{[P in keyof T as P extends K?never:P]:Redacted<T[P],K>}:T;
export type BuyerView<T>=Redacted<T,typeof HIDDEN.buyer[number]>;
export type SellerView<T>=Redacted<T,typeof HIDDEN.seller[number]>;
export function strip(value: unknown,keys: readonly string[]): unknown {
 if(Array.isArray(value)) return value.map(v=>strip(v,keys));
 if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value)
  .filter(([k])=>!keys.includes(k)).map(([k,v])=>[k,strip(v,keys)]));
 return value;
}
export const buyerView=<T,>(x: T)=>strip(x,HIDDEN.buyer) as BuyerView<T>;
export const sellerView=<T,>(x: T)=>strip(x,HIDDEN.seller) as SellerView<T>;

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject=(value: unknown): value is Record<string,unknown>=>!!value&&typeof value==='object';
export function id(value: unknown) { if(typeof value!=='string'||!uuid.test(value)) throw fail('invalid_id'); return value; }
function int(value: unknown,name: string,opts?: {min?: number; max?: number; optional?: false}): number;
function int(value: unknown,name: string,opts: {min?: number; max?: number; optional: true}): number | null;
function int(value: unknown,name: string,{min=0,max=2147483647,optional=false}: {min?: number; max?: number; optional?: boolean}={}) {
 if(value==null&&optional) return null;
 if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max) throw fail('invalid_input',`${name} must be an integer between ${min} and ${max}`);
 return value;
}
function text(value: unknown,name: string,max: number,{optional=true}={}) {
 if(value==null&&optional) return null;
 if(typeof value!=='string'||value.length>max||(!optional&&!value.length)) throw fail('invalid_input',`${name} must be a string of at most ${max} characters`);
 return value;
}
export function key(value: unknown) {
 if(typeof value!=='string'||value.length<1||value.length>200) throw fail('idempotency_key_required');
 return value;
}
function object(value: unknown): Record<string,unknown> {
 if(value==null) return {};
 if(typeof value!=='object'||Array.isArray(value)) throw fail('invalid_input','Body must be a JSON object');
 return value as Record<string,unknown>;
}
export function validateRequirements(r: unknown): Requirements {
 if(!isObject(r)||Array.isArray(r)) throw fail('invalid_input','requirements must be an object');
 if(r.region!=null&&typeof r.region!=='string') throw fail('invalid_input','requirements.region must be a string');
 if(!Array.isArray(r.items)||r.items.length<1||r.items.length>10) throw fail('invalid_input','requirements.items must list 1-10 items');
 (r.items as unknown[]).forEach((item,i)=>{
  if(!isObject(item)||Array.isArray(item)||typeof item.category!=='string')
   throw fail('invalid_input',`requirements.items[${i}].category is required`);
  if(item.quantity!=null) int(item.quantity,`requirements.items[${i}].quantity`,{min:1,max:10});
  for(const [k,v] of Object.entries(item)) if(/^(max|min)_/.test(k)&&typeof v!=='number')
   throw fail('invalid_input',`requirements.items[${i}].${k} must be a number`);
 });
 return r as Requirements;
}

export interface NegotiationOptions { db: RpcDb; demoToken?: string; demoBuyerId?: string }
export type CurrentOffer=OfferJson&{request_id: string; seller_name: string; delivery_days: number; turn: SessionJson['turn'];
 session_version: number; rounds: number; within_budget: boolean};
export class Negotiation {
 db: RpcDb; demoToken?: string; demoBuyerId?: string;
 constructor({db,demoToken,demoBuyerId}: NegotiationOptions) { this.db=db; this.demoToken=demoToken; this.demoBuyerId=demoBuyerId; }
 // RPC results are jsonb built by our own SQL functions (migrations/); callers name the shape.
 async rpc<T=unknown>(name: string,args: Record<string,unknown>): Promise<T> {
  const {data,error}=await this.db.database.rpc(name,args);
  if(error) throw dbError(error);
  return data as T;
 }
 async principal(authorization: string | undefined): Promise<RolePrincipal> {
  const header=authorization??'';
  if(this.demoToken) {
   const expected=Buffer.from(`Bearer ${this.demoToken}`),actual=Buffer.from(header);
   if(expected.length===actual.length&&timingSafeEqual(expected,actual))
    return {scope:'buyer',actor_id:this.demoBuyerId as string,seller_id:null,label:'legacy demo buyer'};
  }
  const match=/^Bearer ([\x21-\x7e]{16,512})$/.exec(header);
  if(!match) throw fail('unauthorized');
  const p=await this.rpc<RolePrincipal | null>('commerce_resolve_principal',{p_token_hash:hashToken(match[1])});
  if(!p) throw fail('unauthorized');
  return p;
 }
 need(p: RolePrincipal,...scopes: RoleScope[]) {
  if(!scopes.includes(p.scope)) throw fail('forbidden',`Requires ${scopes.join(' or ')} scope; this token has ${p.scope} scope`);
 }
 whoami(p: RolePrincipal) { return {scope:p.scope,actor_id:p.actor_id,seller_id:p.seller_id??null,label:p.label}; }

 // Buyer
 async createRequest(p: RolePrincipal,idempotencyKey: unknown,body: unknown) {
  this.need(p,'buyer'); const b=object(body);
  const budget=int(b.budget_cents,'budget_cents',{min:1});
  const target=int(b.target_cents,'target_cents',{min:1,max:budget,optional:true});
  if(b.deadline!=null&&(typeof b.deadline!=='string'||Number.isNaN(Date.parse(b.deadline))))
   throw fail('invalid_input','deadline must be an ISO 8601 timestamp');
  if(b.delegate_negotiation!=null&&typeof b.delegate_negotiation!=='boolean') throw fail('invalid_input','delegate_negotiation must be a boolean');
  return this.rpc<CreatedRequest>('commerce_create_request',{p_buyer:p.actor_id,p_key:key(idempotencyKey),p_title:text(b.title,'title',200),
   p_requirements:validateRequirements(b.requirements),p_budget_cents:budget,p_target_cents:target,
   p_deadline:b.deadline??null,p_delegate:b.delegate_negotiation??true});
 }
 async requestState(p: RolePrincipal,requestId: unknown) {
  this.need(p,'buyer');
  const state=await this.rpc<RequestState | null>('commerce_request_state',{p_request:id(requestId)});
  if(!state) throw fail('request_not_found');
  if(state.buyer_id!==p.actor_id) throw fail('forbidden');
  return state;
 }
 async getRequest(p: RolePrincipal,requestId: unknown) {
  const {buyer_id,...state}=await this.requestState(p,requestId);
  return buyerView(state);
 }
 async listOffers(p: RolePrincipal,requestId: unknown) {
  const state=await this.requestState(p,requestId);
  // session_version (not the offer's own) is what a counter must send as expected_version.
  return buyerView(state.sessions.filter((s): s is SessionJson&{current_offer: OfferJson}=>!!(s.status==='open'&&s.current_offer?.is_current))
   .map((s): CurrentOffer=>({
   ...s.current_offer,request_id:state.request_id,seller_name:s.seller_name,delivery_days:s.seller.delivery_days,
   turn:s.turn,session_version:s.version,rounds:s.rounds,within_budget:s.current_offer.total_cents<=state.budget_cents}))
   .sort((a,b)=>a.total_cents-b.total_cents));
 }
 async counter(p: RolePrincipal,sessionId: unknown,idempotencyKey: unknown,body: unknown) {
  this.need(p,'buyer'); const b=object(body);
  return this.rpc<CreatedCounter>('commerce_buyer_counter',{p_buyer:p.actor_id,p_session:id(sessionId),p_key:key(idempotencyKey),
   p_expected_version:int(b.expected_version,'expected_version'),p_total_cents:int(b.total_cents,'total_cents',{min:1}),
   p_note:text(b.note,'note',2000)});
 }

 // Buyer or seller
 async getSession(p: RolePrincipal,sessionId: unknown) {
  this.need(p,'buyer','seller');
  const state=await this.rpc<SessionState | null>('commerce_session_state',{p_session:id(sessionId)});
  if(!state) throw fail('session_not_found');
  if(p.scope==='seller') {
   if(state.seller_id!==p.seller_id) throw fail('forbidden');
   return {role:'seller' as const,...sellerView(state)};
  }
  if(state.request.buyer_id!==p.actor_id) throw fail('forbidden');
  return {role:'buyer' as const,...buyerView(state)};
 }
 async decline(p: RolePrincipal,sessionId: unknown,idempotencyKey: unknown,body: unknown) {
  this.need(p,'buyer','seller'); key(idempotencyKey); const b=object(body);
  return this.rpc<DeclinedSession>('commerce_decline_session',{p_actor:p.actor_id,p_scope:p.scope,p_seller:p.seller_id??null,
   p_session:id(sessionId),p_reason:text(b.reason,'reason',500)});
 }

 // Seller
 async sellerSessions(p: RolePrincipal,status: string | null) {
  this.need(p,'seller');
  if(status!=null&&!['open','declined','closed'].includes(status)) throw fail('invalid_input','status must be open, declined or closed');
  return sellerView(await this.rpc<SellerSession[]>('commerce_seller_sessions',{p_seller:p.seller_id,p_status:status??null}));
 }
 async sellerInventory(p: RolePrincipal) {
  this.need(p,'seller');
  return sellerView(await this.rpc<InventoryItem[]>('commerce_seller_inventory',{p_seller:p.seller_id}));
 }
 async makeOffer(p: RolePrincipal,sessionId: unknown,idempotencyKey: unknown,body: unknown) {
  this.need(p,'seller'); const b=object(body);
  if(!Array.isArray(b.items)||b.items.length<1||b.items.length>20) throw fail('invalid_input','items must list 1-20 lines');
  const items=(b.items as unknown[]).map((item,i)=>{
   if(!isObject(item)) throw fail('invalid_input',`items[${i}] must be an object`);
   if(typeof item.inventory_id!=='string'||!uuid.test(item.inventory_id)) throw fail('invalid_input',`items[${i}].inventory_id must be a UUID`);
   return {inventory_id:item.inventory_id,quantity:int(item.quantity,`items[${i}].quantity`,{min:1,max:100}),
    unit_cents:int(item.unit_cents,`items[${i}].unit_cents`,{min:1,max:100000000})};
  });
  return this.rpc<CreatedOffer>('commerce_seller_offer',{p_seller:p.seller_id,p_session:id(sessionId),p_key:key(idempotencyKey),
   p_expected_version:int(b.expected_version,'expected_version'),p_items:items,
   p_delivery_cents:int(b.delivery_cents,'delivery_cents',{max:10000000,optional:true}),p_note:text(b.note,'note',2000)});
 }

 // Worker
 async workerEvents(p: RolePrincipal,limit?: string | null) {
  this.need(p,'worker');
  const n=limit==null||limit===''?20:Number(limit);
  if(!Number.isInteger(n)||n<1||n>100) throw fail('invalid_input','limit must be an integer between 1 and 100');
  return this.rpc<WorkerEvent[]>('commerce_worker_events',{p_limit:n});
 }
 async ackEvent(p: RolePrincipal,eventId: unknown) {
  this.need(p,'worker');
  return this.rpc<EventAck>('commerce_ack_event',{p_event:id(eventId)});
 }
 async setAgentHandle(p: RolePrincipal,sellerId: unknown,body: unknown) {
  this.need(p,'worker');
  return this.rpc<AgentHandle>('commerce_set_agent_handle',{p_seller:id(sellerId),
   p_handle:text(object(body).agent_handle,'agent_handle',200,{optional:false})});
 }
}
