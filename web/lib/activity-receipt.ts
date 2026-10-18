import type {Conversation} from './conversation.ts';
import type {OrderStatus} from './workspace.ts';
import {priceHistory} from './price-history.ts';
import {selectedSeller,sellerOffer} from './watch-view.ts';
import {verifiedPurchase} from './purchase-finish.ts';

export function activityReceipt(c:Conversation,receipt:OrderStatus|null,now=Date.now()) {
 const contacts=new Set<string>(),offers=new Set<string>(),counters=new Set<string>(),deliveries=new Set<string>();
 const raw=c.sessions.flatMap(s=>s.messages.map((m,i)=>({session:s,m,key:`${s.session_id}:${m.kind}:${m.offer_id??m.counter_id??`${m.at}:${i}`}`})));
 const evidence=[...new Map(raw.map(e=>[e.key,e])).values()].sort((a,b)=>Date.parse(a.m.at)-Date.parse(b.m.at)||a.key.localeCompare(b.key));
 for(const {session:s,m,key} of evidence){
  if((m.by==='seller'||m.by==='buyer')&&m.kind!=='opened'||m.kind==='opened'&&m.delivery)contacts.add(s.seller_id);
  if(m.kind==='offer'&&m.by==='seller'&&typeof m.total_cents==='number'&&Number.isFinite(m.total_cents)&&m.total_cents>=0)offers.add(key);
  if(m.kind==='counter'&&m.by==='buyer'&&typeof m.total_cents==='number'&&Number.isFinite(m.total_cents)&&m.total_cents>=0)counters.add(key);
  if(m.delivery)deliveries.add(m.delivery.message_id?`${m.delivery.transport}:${m.delivery.message_id}`:key);
 }
 const seller=selectedSeller(c)??[...c.sessions].filter(s=>sellerOffer(s,now).eligible).sort((a,b)=>sellerOffer(a,now).total!-sellerOffer(b,now).total!)[0];
 const chosen=selectedSeller(c),opening=seller?priceHistory(seller)[0]?.cents:undefined,total=chosen?c.reservation?.total_cents:seller?sellerOffer(seller,now).total:undefined;
 const reduction=opening!==undefined&&total!==undefined?opening-total:null;
 const r=c.reservation;
 const payment=receipt?.order?.status==='refunded'?'Refunded':receipt?.order?.status==='cancelled'?'Cancelled':verifiedPurchase(c,receipt)?'Verified':r?.status==='failed'?'Failed':r?.status==='expired'?'Expired':r?.status==='payment_pending'||r?.status==='consumed'||c.status==='confirmed'?'Verifying':c.status==='awaiting_payment'?'Approval needed':'Not started';
 return {contacts:contacts.size,offers:offers.size,counters:counters.size,moves:offers.size+counters.size,deliveries:deliveries.size,reduction,opening,total,seller:seller?.seller_name??null,payment,evidence};
}
