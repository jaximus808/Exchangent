'use client';
import {ArrowDownRight,ArrowUpRight,CheckCircle2,FileCheck2,MessageSquareText,Store} from 'lucide-react';
import type {Conversation} from '@/lib/conversation';
import {activityReceipt} from '@/lib/activity-receipt';
import {money,type OrderStatus} from '@/lib/workspace';
import './activity-receipt.css';
export function ActivityReceipt({conversation,receipt,now}:{conversation:Conversation;receipt:OrderStatus|null;now:number}) {
 const facts=activityReceipt(conversation,receipt,now);
 return <section className="activity-receipt" aria-label="What happened"><header><FileCheck2 size={15}/><h2>What happened</h2><span>From saved records</span></header>
  <dl className="activity-facts"><div><dt><Store size={13}/>Sellers contacted</dt><dd>{facts.contacts}</dd></div><div><dt><MessageSquareText size={13}/>Offers & counters</dt><dd>{facts.moves}</dd></div><div><dt>{facts.reduction!==null&&facts.reduction<0?<ArrowUpRight size={13}/>:<ArrowDownRight size={13}/>}Price {facts.reduction!==null&&facts.reduction<0?'increase':'reduction'}</dt><dd>{facts.reduction===null?'—':money(Math.abs(facts.reduction))}</dd></div><div className={facts.payment==='Verified'?'verified':''}><dt><CheckCircle2 size={13}/>Payment</dt><dd>{facts.payment}</dd></div></dl>
  <details className="activity-evidence"><summary>View evidence</summary><div className="activity-evidence-body"><p>{facts.offers} seller offers · {facts.counters} buyer counters · {facts.deliveries} recorded deliveries</p>{facts.seller&&facts.opening!==undefined&&facts.total!==undefined&&<p>{facts.seller}: {money(facts.opening)} first recorded → {money(facts.total)} {conversation.reservation&&facts.payment!=='Expired'&&facts.payment!=='Failed'?'reserved':'current'} total</p>}
   <ol>{facts.evidence.filter(e=>e.m.kind!=='opened').slice(-30).map(({session:s,m,key})=><li key={key}><span>{m.by==='buyer'?'Buyer':m.by==='seller'?s.seller_name:'Platform'} · {m.kind}</span><b>{m.total_cents!==undefined?money(m.total_cents):'—'}</b><time dateTime={m.at}>{new Date(m.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</time>{m.delivery&&<small>{m.delivery.transport==='inkbox'?'Inkbox A2A':m.delivery.transport==='local'?'In-process delivery':'Delivery recorded'}{m.delivery.message_id?` · ${m.delivery.message_id.slice(0,8)}`:''}</small>}</li>)}</ol>{facts.evidence.length>30&&<p>Latest 30 records shown. Full messages are in activity history.</p>}
   <small>Counts cover recorded negotiation activity. Price change compares the same seller. Payment verification requires the matching confirmed order receipt.</small>
  </div></details>
 </section>;
}
