import type {Conversation} from './conversation.ts';
import type {InventoryItem,OrderStatus} from './workspace.ts';

/** Match every identity and amount before presenting a verified purchase. */
export function verifiedPurchase(c:Conversation,receipt:OrderStatus|null) {
 const r=c.reservation,o=receipt?.order;
 if(!r||!receipt||!o||c.status!=='confirmed'||r.status!=='consumed'||receipt.status!=='consumed'||o.status!=='confirmed'||receipt.request_id!==c.request_id||receipt.reservation_id!==r.reservation_id||receipt.currency!=='usd'||o.currency!=='usd'||receipt.total_cents!==r.total_cents||o.total_cents!==r.total_cents||typeof o.id!=='string'||!o.id||typeof receipt.seller?.name!=='string'||!Number.isSafeInteger(r.total_cents)||r.total_cents<0||!receipt.seller?.id||(r.seller_id&&receipt.seller.id!==r.seller_id)||!Array.isArray(receipt.items)||!receipt.items.length)return null;
 if(!receipt.items.every(i=>i&&typeof i.title==='string'&&Number.isSafeInteger(i.quantity)&&i.quantity>0&&Number.isSafeInteger(i.unit_cents)&&i.unit_cents>=0))return null;
 const subtotal=receipt.items.reduce((n,i)=>n+i.quantity*i.unit_cents,0),delivery=receipt.delivery_cents,tax=receipt.tax_cents;
 if(typeof delivery!=='number'||typeof tax!=='number'||!Number.isSafeInteger(delivery)||!Number.isSafeInteger(tax)||delivery<0||tax<0||subtotal+delivery+tax!==r.total_cents)return null;
 return {order:o,seller:receipt.seller,items:receipt.items,quantity:receipt.items.reduce((n,i)=>n+i.quantity,0),total:r.total_cents};
}
export type StockMove={id:string;title:string;beforeAvailable:number;available:number;beforeSold:number|null;sold:number|null};
/** Owner-only inventory snapshots. No stock totals are exposed to the buyer. */
export function stockMoves(before:InventoryItem[]|null|undefined,after:InventoryItem[]) {
 if(!before)return [];
 const prior=new Map(before.map(i=>[i.inventory_id,i]));
 return after.flatMap(i=>{const old=prior.get(i.inventory_id);return old&&(old.available!==i.available||(old.sold??null)!==(i.sold??null))?[{id:i.inventory_id,title:i.title,beforeAvailable:old.available,available:i.available,beforeSold:old.sold??null,sold:i.sold??null}]:[];});
}
