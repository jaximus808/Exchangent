import {z} from 'zod';

// get_order / get_case results (doc/resolution-contract.md). Field names are read tolerantly
// (`id` or `order_id`, `moves` or `history`) so the panel keeps working as the backend evolves.
const cents=z.number().int().nonnegative();
const remedy=z.looseObject({kind:z.string(),amount_cents:cents.optional(),items:z.array(z.looseObject({})).optional(),return_shipping_paid_by:z.string().optional(),how:z.string().optional()});
const move=z.looseObject({by:z.string().optional(),action:z.string().optional(),remedy:remedy.nullable().optional(),note:z.string().nullable().optional(),version:z.number().optional(),created_at:z.string().optional(),at:z.string().optional()});
const refund=z.looseObject({amount_cents:cents.optional(),status:z.string().optional(),reason:z.string().nullable().optional(),created_at:z.string().optional()});
const evidence=z.looseObject({kind:z.string().optional(),ref:z.string().optional(),by:z.string().optional(),at:z.string().optional()});
const caseShape=z.looseObject({case_id:z.string().optional(),id:z.string().optional(),case_status:z.string().optional(),status:z.string().optional(),type:z.string().optional(),turn:z.string().optional(),version:z.number().optional(),rounds:z.number().optional(),opened_by:z.string().optional(),description:z.string().nullable().optional(),
 evidence:z.array(evidence).nullable().optional(),moves:z.array(move).optional(),history:z.array(move).optional(),resolution:remedy.nullable().optional(),
 substitute_check:z.looseObject({meets_requirements:z.boolean().optional(),unit_cents_delta:z.number().optional(),category:z.string().optional()}).nullable().optional(),refunds:z.array(refund).optional(),created_at:z.string().optional()});
const item=z.looseObject({title:z.string().optional(),quantity:z.number().optional(),unit_cents:cents.optional()});
export const resolutionSchema=caseShape.extend({status:z.enum(['ok','error']),order_id:z.string().optional(),order_status:z.string().optional(),title:z.string().nullable().optional(),seller_name:z.string().optional(),
 seller:z.looseObject({name:z.string().optional()}).nullable().optional(),total_cents:cents.optional(),refunded_cents:cents.optional(),carrier:z.string().nullable().optional(),tracking:z.string().nullable().optional(),
 created_at:z.string().optional(),paid_at:z.string().nullable().optional(),shipped_at:z.string().nullable().optional(),delivered_at:z.string().nullable().optional(),dispute_window_ends_at:z.string().nullable().optional(),
 delivery_evidence:z.looseObject({source:z.string().optional(),at:z.string().optional()}).nullable().optional(),items:z.array(item).optional(),cases:z.array(caseShape).optional(),
 viewer:z.string().optional(),role:z.string().optional(),error:z.looseObject({code:z.string()}).optional(),next:z.string().optional()});
export type Resolution=z.infer<typeof resolutionSchema>;
export type Case=z.infer<typeof caseShape>;
export type Move=z.infer<typeof move>;
export type Remedy=z.infer<typeof remedy>;

export function readResolution(value:unknown):Resolution {
 const parsed=resolutionSchema.safeParse(value);
 if(!parsed.success)throw Error('These order details could not be displayed. Ask your assistant to refresh them.');
 return parsed.data;
}
export const caseId=(c:Case)=>c.case_id??c.id;
export const caseStatus=(c:Case)=>c.case_status??c.status;
export const movesOf=(c:Case)=>c.moves??c.history??[];

const TYPES:Record<string,string>={not_received:'Not received',not_as_described:'Not as described',damaged:'Arrived damaged',missing_item:'Item missing',late:'Delivered late',wrong_item:'Wrong item',changed_mind:'Changed mind',duplicate_charge:'Charged twice',substitution:'Out of stock · substitute offered'};
export const caseTypeLabel=(type?:string)=>TYPES[type??'']??(type??'Problem').replaceAll('_',' ');

const money=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
/** "Keep it with $60.00 back", "Return for a refund (seller pays return shipping)", … */
export function remedyLabel(r?:Remedy|null):string {
 if(!r)return 'No remedy proposed';
 const amount=r.amount_cents!==undefined?money(r.amount_cents):'';
 switch(r.kind) {
  case 'refund_full':return 'Full refund';
  case 'refund_partial':return amount?`${amount} back, keep the goods`:'Partial refund';
  case 'refund_items':return `Refund ${r.items?.length?`${r.items.length} item${r.items.length===1?'':'s'}`:'the affected items'}${amount?` (${amount})`:''}`;
  case 'replace':return 'Ship a replacement';
  case 'return_for_refund':return `Return for a refund${r.return_shipping_paid_by?` (${r.return_shipping_paid_by} pays return shipping)`:''}`;
  case 'keep_with_discount':return amount?`Keep it with ${amount} back`:'Keep it with a discount';
  case 'sla_credit':return amount?`${amount} delivery credit`:'Delivery-fee credit';
  case 'cancel':return 'Cancel before shipping';
  default:return r.kind.replaceAll('_',' ');
 }
}
const HOW:Record<string,string>={auto:'Settled automatically from verified facts',policy:'Accepted under the seller’s resolution policy',agreed:'Agreed by both sides'};
export const resolvedHow=(how?:string)=>HOW[how??'']??'Resolved';

/** Paid → Shipped → Delivered → Closed, with the delivery source called out when it was simulated for testing. */
export function timeline(d:Resolution):{label:string;at?:string|null;done:boolean;detail?:string}[] {
 const s=d.order_status??'';
 const delivered=!!d.delivered_at||['delivered','closed'].includes(s);
 const source=d.delivery_evidence?.source;
 return [
  {label:'Paid',at:d.paid_at??d.created_at,done:true},
  {label:'Shipped',at:d.shipped_at,done:!!d.shipped_at||['shipped','delivered','closed'].includes(s),detail:d.carrier?`${d.carrier}${d.tracking?` · ${d.tracking}`:''}`:undefined},
  {label:'Delivered',at:d.delivered_at,done:delivered,detail:source==='simulated'?'Simulated carrier scan (test mode)':source==='buyer_confirmed'?'Confirmed by the buyer':source==='carrier'?'Carrier scan':undefined},
  {label:s==='refunded'?'Refunded':s==='cancelled'?'Cancelled':'Closed',at:null,done:['closed','refunded','cancelled'].includes(s)},
 ];
}
