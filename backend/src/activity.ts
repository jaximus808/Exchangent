import {CommerceError} from './commerce.ts';
import type {Commerce} from './commerce.ts';
import {authorize,requireUser,UUID} from './auth.ts';
import type {Db, DelegationScope, OfferItemRow, OfferRow, Principal, RequestRow, ReservationRow, Row, SellerRow} from './types.ts';

export type RequestSummary = Pick<RequestRow,'id'|'requirements'|'status'|'currency'|'created_at'>;
export interface OfferSummary extends Pick<OfferRow,'id'|'seller_id'|'version'|'delivery_cents'|'tax_cents'|'expires_at'|'is_current'> {
  items: OfferItemRow[]; total_cents: number;
}
export class Activity {
  commerce: Commerce; db: Db;
  constructor(commerce: Commerce) {this.commerce=commerce;this.db=commerce.db;}
  async requests(principal: Principal) {
    requireUser(principal);
    const {data,error}=await this.db.database.from('commerce_requests')
      .select('id,requirements,status,currency,created_at').eq('buyer_id',principal.actorId)
      .order('created_at',{ascending:false}).limit(50);
    if(error) throw new CommerceError('database_error',503);
    return (data??[]) as RequestSummary[];
  }
  async createRequest(principal: Principal,input: Record<string, unknown>,key: unknown) {
    requireUser(principal);
    if(typeof key!=='string'||key.length<1||key.length>200 || typeof input.requirements!=='string'||
       !input.requirements.trim()||input.requirements.length>4000 || typeof input.budget_cents!=='number'||!Number.isSafeInteger(input.budget_cents)||
       input.budget_cents<1||input.budget_cents>100000000 || (input.currency??'usd')!=='usd')
      throw new CommerceError('invalid_input',400);
    return this.commerce.rpc<RequestSummary>('commerce_create_request',{p_buyer:principal.actorId,p_key:key,
      p_requirements:input.requirements.trim(),p_budget:input.budget_cents});
  }
  async list<T = Row>(table: string,columns: string,field: string,id: string,limit=50): Promise<T[]> {
    const {data,error}=await this.db.database.from(table).select(columns).eq(field,id).limit(limit);
    if(error) throw new CommerceError('database_error',503);
    return (data??[]) as T[];
  }
  async request(principal: Principal,id: string): Promise<RequestSummary> {
    if(!UUID.test(id)) throw new CommerceError('invalid_id',400);
    authorize(principal,'request:read',{requestId:id});
    const q=await this.commerce.row<RequestRow>('commerce_requests',id);
    if(q.buyer_id!==principal.actorId) throw new CommerceError('forbidden',403);
    return {id:q.id,requirements:q.requirements,status:q.status,currency:q.currency,created_at:q.created_at};
  }
  async offers(principal: Principal,id: string) {
    await this.request(principal,id);
    const rows=await this.list<OfferSummary>('commerce_offers','id,seller_id,version,delivery_cents,tax_cents,expires_at,is_current','request_id',id);
    const offers: OfferSummary[]=[];
    for(const offer of rows.filter(o=>o.is_current)) {
      const items=await this.list<OfferItemRow>('commerce_offer_items','inventory_id,quantity,unit_cents','offer_id',offer.id);
      offers.push({...offer,items,total_cents:items.reduce((n,i)=>n+i.quantity*i.unit_cents,offer.delivery_cents+offer.tax_cents)});
    }
    return offers;
  }
  async seller(principal: Principal,id: string) {
    if(!UUID.test(id)) throw new CommerceError('invalid_id',400);
    authorize(principal,'seller:read',{sellerId:id});
    const seller=await this.commerce.row<SellerRow>('commerce_sellers',id);
    if(seller.owner_id!==principal.actorId) throw new CommerceError('forbidden',403);
    const offers=await this.list('commerce_offers','id,request_id,version,expires_at,is_current','seller_id',id);
    const orders=await this.list('commerce_orders','id,status,total_cents,currency,created_at','seller_id',id);
    // No private buyer ceilings, contact details or cross-seller transcripts.
    return {seller:{id:seller.id,name:seller.name,enabled:seller.enabled},offers,orders};
  }
  async reservation(principal: Principal,id: string,scope: DelegationScope='request:read') {
    if(!UUID.test(id)) throw new CommerceError('invalid_id',400);
    const r=await this.commerce.row<ReservationRow>('commerce_reservations',id);
    authorize(principal,scope,{requestId:r.request_id});
    if(r.buyer_id!==principal.actorId) throw new CommerceError('forbidden',403);
    return r;
  }
  async reserve(principal: Principal,offerId: string,key: unknown,input: {expected_total_cents?: unknown}={}) {
    if(!UUID.test(offerId)) throw new CommerceError('invalid_id',400);
    const o=await this.commerce.row<OfferRow>('commerce_offers',offerId);
    authorize(principal,'reservation:write',{requestId:o.request_id});
    return this.commerce.reserve(principal.actorId,offerId,key,input.expected_total_cents);
  }
  async checkout(principal: Principal,id: string) {
    await this.reservation(principal,id,'checkout:write');
    return this.commerce.checkout(principal.actorId,id);
  }
  async status(principal: Principal,id: string) {
    await this.reservation(principal,id);
    return this.commerce.status(principal.actorId,id);
  }
}
