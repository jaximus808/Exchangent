export type BuyRequest={id:string;requirements:string;status:string;currency:string;created_at:string;title?:string;budget_cents?:number};
export type Offer={id:string;seller_id:string;version:number;delivery_cents:number;tax_cents:number;expires_at:string;is_current:boolean;items:{inventory_id:string;quantity:number;unit_cents:number}[];total_cents:number};
export type OrderStatus={request_id?:string;reservation_id:string;status:string;total_cents:number;currency:string;seller?:{id:string;name:string};items?:{title:string;quantity:number;unit_cents:number}[];subtotal_cents?:number;delivery_cents?:number;tax_cents?:number;order:{id:string;status:string;total_cents:number;currency:string;created_at:string}|null};
export type Business={seller_id:string;name:string;service_area:string;delivery_cents:number;delivery_days:number;delegate_negotiation:boolean;enabled:boolean;agent_handle:string|null;created_at:string;owner_email?:string|null;inventory?:InventoryItem[]};
export type InventoryItem={inventory_id:string;sku:string;title:string;category:string|null;attributes?:Record<string,unknown>;list_cents:number|null;floor_cents:number;available:number;sold?:number};

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
 business_name_taken:'Another business already uses that name. Try a different one.',
 business_limit:'You’ve reached the limit of five businesses.',
 invalid_input:'Check the values and try again.',
 forbidden:'You don’t have access to that.',
};
export const errorText=(e:unknown,fallback='Something went wrong. Please try again.')=>e instanceof ApiError?(friendly[e.code]??e.message):e instanceof Error?e.message:fallback;
