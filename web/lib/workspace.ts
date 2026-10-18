export type BuyRequest={id:string;requirements:string;status:string;currency:string;created_at:string;title?:string;budget_cents?:number};
export type Offer={id:string;seller_id:string;version:number;delivery_cents:number;tax_cents:number;expires_at:string;is_current:boolean;items:{inventory_id:string;quantity:number;unit_cents:number}[];total_cents:number};
export type OrderStatus={request_id?:string;reservation_id:string;status:string;total_cents:number;currency:string;seller?:{id:string;name:string};items?:{title:string;quantity:number;unit_cents:number}[];subtotal_cents?:number;delivery_cents?:number;tax_cents?:number;order:{id:string;status:string;total_cents:number;currency:string;created_at:string}|null};
export type Business={seller_id:string;name:string;service_area:string;delivery_cents:number;delivery_days:number;delegate_negotiation:boolean;enabled:boolean;agent_handle:string|null;created_at:string;owner_email?:string|null;inventory?:InventoryItem[]};
export type InventoryItem={inventory_id:string;sku:string;title:string;category:string|null;attributes?:Record<string,unknown>;list_cents:number|null;floor_cents:number;available:number;sold?:number};

/** A problem-case remedy (doc/resolution-contract.md). Amounts are always computed and capped by the backend. */
export type Remedy={kind:string;amount_cents?:number;items?:unknown[];return_shipping_paid_by?:'buyer'|'seller';how?:string};
export type CaseMove={by?:string;action?:string;remedy?:Remedy|null;note?:string|null;version?:number;created_at?:string;at?:string};
export type Refund={amount_cents?:number;status?:string;reason?:string|null;created_at?:string};
export type Case={case_id?:string;id?:string;order_id?:string;type?:string;status?:string;turn?:string;version?:number;rounds?:number;opened_by?:string;description?:string|null;
 moves?:CaseMove[];history?:CaseMove[];resolution?:Remedy|null;substitute_check?:{meets_requirements?:boolean;unit_cents_delta?:number;category?:string}|null;
 evidence?:{kind?:string;ref?:string;by?:string}[]|null;refunds?:Refund[];title?:string|null};
export type OrderItem={id?:string;reservation_item_id?:string;title?:string;quantity?:number;unit_cents?:number};
export type Order={order_id?:string;id?:string;request_id?:string;status?:string;title?:string|null;seller_name?:string;total_cents?:number;refunded_cents?:number;
 carrier?:string|null;tracking?:string|null;created_at?:string;shipped_at?:string|null;delivered_at?:string|null;dispute_window_ends_at?:string|null;
 delivery_evidence?:{source?:string;at?:string}|null;items?:OrderItem[];cases?:Case[];refunds?:Refund[];shipping_name?:string|null};
export type Policy={auto_refund_not_received_after_days?:number;max_auto_partial_refund_pct?:number;return_window_days?:number;restocking_fee_pct?:number;
 seller_pays_return_shipping_when_at_fault?:boolean;price_protection_days?:number;fight_chargebacks_above_cents?:number};
export const orderIdOf=(o:Order)=>o.order_id??o.id??'';
export const caseIdOf=(c:Case)=>c.case_id??c.id??'';
export const itemIdOf=(i:OrderItem)=>i.reservation_item_id??i.id??'';
/** Accept either a bare array or `{<key>:[…]}` from list routes. */
export function listOf<T>(raw:unknown,key:string):T[] {
 if(Array.isArray(raw)) return raw as T[];
 const inner=raw&&typeof raw==='object'?(raw as Record<string,unknown>)[key]:undefined;
 return Array.isArray(inner)?inner as T[]:[];
}

export const MCP_URL='https://fast-cloud-tpp4j.run.mcp-use.com/mcp';
export const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2}).format(cents/100);
export const dollarsToCents=(v:string)=>{const n=Number(v);return Number.isFinite(n)&&v.trim()!==''?Math.round(n*100):NaN;};

/** A backend error with its snake_case code (business_name_taken, forbidden, …) for friendly copy. */
export class ApiError extends Error {
 code:string;status:number;
 constructor(message:string,code:string,status:number){super(message);this.code=code;this.status=status;}
}
export async function api<T>(path:string,init:RequestInit={}):Promise<T> {
 const response=await fetch(`/api/commerce/${path}`,{...init,headers:{'content-type':'application/json',...init.headers},cache:'no-store'});
 const result=await response.json().catch(()=>({}));
 if(!response.ok) {
  const code=result.error?.code??'error';
  throw new ApiError(response.status===401?'Your session has expired. Please sign in again.':result.error?.message??'Something went wrong. Please try again.',code,response.status);
 }
 return result.data;
}
const friendly:Record<string,string>={
 round_limit:'This negotiation hit its round limit and closed.',
 too_many_requests:'Too many open requests right now. Let some finish first.',
 refund_failed:'The refund was agreed but Stripe hasn’t issued it yet. It’s saved; try again shortly.',
 stale_offer:'This changed since you loaded it. Refresh and try again.',
 not_your_turn:'It’s the other side’s turn. Wait for their response.',
 session_closed:'This is already closed.',
 business_name_taken:'Another business already uses that name. Try a different one.',
 business_limit:'You’ve reached the limit of five businesses.',
 invalid_input:'Check the values and try again.',
 forbidden:'You don’t have access to that.',
};
export const errorText=(e:unknown,fallback='Something went wrong. Please try again.')=>e instanceof ApiError?(friendly[e.code]??e.message):e instanceof Error?e.message:fallback;
