import type {ConvSession} from './conversation.ts';

/** Recorded seller prices only. Buyer counters must never look like accepted offers. */
export function priceHistory(session:ConvSession) {
 return session.messages.filter(m=>m.kind==='offer'&&m.by==='seller'&&typeof m.total_cents==='number'&&Number.isFinite(m.total_cents)&&m.total_cents>=0&&Number.isFinite(Date.parse(m.at)))
  .map((m,index)=>({cents:m.total_cents!,at:m.at,id:m.offer_id??`${m.at}-${index}`,index}))
  .sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.index-b.index);
}
export function trendPoints(values:number[],width=100,height=28,domain?:[number,number]) {
 if(!values.length)return [];
 const min=domain?.[0]??0,max=domain?.[1]??Math.max(...values),range=max-min;
 return values.map((v,i)=>({x:values.length===1?width/2:3+i*(width-6)/(values.length-1),y:range?4+(max-v)*(height-8)/range:height/2}));
}
