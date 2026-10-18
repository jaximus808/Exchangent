'use client';
import {priceHistory,trendPoints} from '@/lib/price-history';
import type {ConvSession} from '@/lib/conversation';
import {money} from '@/lib/workspace';
import './negotiation-visual.css';

/** Optional audit detail: opening and subsequent seller offers, not buyer targets. */
export function PriceTrend({session,compact=false,maxCents}:{session:ConvSession;compact?:boolean;maxCents?:number}) {
 const history=priceHistory(session),points=trendPoints(history.map(p=>p.cents),100,28,maxCents!==undefined?[0,maxCents]:undefined);
 if(!history.length)return null;
 const first=history[0].cents,last=history.at(-1)!.cents;
 return <details className={`price-history ${compact?'compact':''}`}>
  <summary aria-label={`${session.seller_name} price history: ${history.length} seller offers, ${money(first)} to ${money(last)}`}>
   <svg viewBox="0 0 100 28" width="100" height="28" aria-hidden="true"><path d="M3 24H97" className="trend-baseline"/><polyline points={points.map(p=>`${p.x},${p.y}`).join(' ')} className="trend-line"/>{points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={i===points.length-1?2.5:1.8}/>)}</svg>
   <span>{compact?'History':`${money(first)} → ${money(last)}`}</span>
  </summary>
  <div className="price-history-detail"><strong>Seller offer history</strong><ol>{history.map((p,i)=><li key={p.id}><span>{i===0?'Opening':`Offer ${i+1}`}</span><b>{money(p.cents)}</b><time dateTime={p.at}>{new Date(p.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</time></li>)}</ol></div>
 </details>;
}
