'use client';
import {memo,useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,Check,Layers3} from 'lucide-react';
import type {Conversation} from '@/lib/conversation';
import {priceHistory} from '@/lib/price-history';
import {recordedMoves} from '@/lib/negotiation-events';
import {selectedSeller,sellerOffer,watchState} from '@/lib/watch-view';
import {money} from '@/lib/workspace';
import {at,buyer,buyerParts,labels,routes,sellerParts,type Part} from './iso/exchange-geometry';
import './negotiation-visual.css';

const Solid=memo(function Solid({part}:{part:Part}) {
 const p=part.paths;
 return <g className={`exchange-solid ${part.kind}`}><path className="ex-fill" d={p.fill}/>{p.shades.map((d,i)=>d?<path className={`ex-shade s${i}`} d={d} key={i}/>:null)}<path className="ex-top" d={p.top}/><path className="ex-edge" d={p.outline}/>{p.bevel&&<path className="ex-bevel" d={p.bevel}/>}</g>;
});

export function NegotiationMap({conversation,now,filter,onSelect,connected=true}:{conversation:Conversation;now:number;filter:string;onSelect:(id:string)=>void;connected?:boolean}) {
 const[page,setPage]=useState(0),[pulse,setPulse]=useState<Record<string,{key:string;buyer:boolean}>>({}),[visible,setVisible]=useState(false);
 const root=useRef<HTMLElement>(null),seen=useRef<Set<string>|null>(null);
 const pages=Math.max(1,Math.ceil(conversation.sessions.length/3)),safePage=Math.min(page,pages-1),sessions=conversation.sessions.slice(safePage*3,safePage*3+3);
 const state=watchState(conversation,now),chosen=selectedSeller(conversation);
 useEffect(()=>{const index=conversation.sessions.findIndex(s=>s.session_id===filter);if(index>=0)setPage(Math.floor(index/3));},[filter,conversation.sessions]);
 useEffect(()=>{const el=root.current;if(!el)return;const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting));observer.observe(el);return()=>observer.disconnect();},[]);
 useEffect(()=>{
  const update=recordedMoves(conversation.sessions,seen.current);seen.current=update.seen;setPulse(update.moves);
  const timer=setTimeout(()=>setPulse({}),1400);return()=>clearTimeout(timer);
 },[conversation]);
 const focused=conversation.sessions.find(s=>s.session_id===filter);
 const scope=focused?[focused]:conversation.sessions;
 const latest=scope.flatMap(s=>s.messages.filter(m=>m.kind!=='opened').map(m=>({s,m}))).sort((a,b)=>Date.parse(b.m.at)-Date.parse(a.m.at))[0];
 const buyerLabel=conversation.delegate_negotiation===false?'Your assistant':'Your buying agent';
 return <section className="exchange-map" ref={root} aria-label="Live negotiation diagram">
  <header><div><Layers3 size={15}/><h2>The exchange</h2></div><span>{state.kind==='confirmed'?'Purchase complete':state.kind==='verifying'?'Verifying payment':!connected?'Reconnecting':state.live?'Negotiating':state.label}</span></header>
  <div className="exchange-viewport" tabIndex={0} role="region" aria-label="Exchange diagram; scroll to view all seller stations"><div className={`exchange-stage ${visible?'in-view':''} ${connected?'':'offline'}`}>
   <svg viewBox="0 0 900 325" aria-hidden="true" focusable="false">
    {sessions.map((s,i)=><path key={s.session_id} d={routes[i]} className={`exchange-route ${chosen?.session_id===s.session_id?'purchased':''} ${filter===s.session_id?'focused':''}`}/>)}
    {sessions.map((s,i)=><g key={s.session_id} className={`exchange-station ${filter===s.session_id?'focused':''} ${chosen?.session_id===s.session_id?'purchased':''}`}>{sellerParts[i].map((part,j)=><Solid part={part} key={j}/>)}</g>)}
    {sessions.map((s,i)=>pulse[s.session_id]&&visible&&connected?<g key={pulse[s.session_id].key} className={`exchange-packet ${pulse[s.session_id].buyer?'outbound':''}`} style={{offsetPath:`path('${routes[i]}')`}}><rect x="-5" y="-3" width="10" height="6" rx="1"/></g>:null)}
    <g className="exchange-buyer">{buyerParts.map((part,i)=><Solid key={i} part={part}/>)}</g>
   </svg>
   <div className="exchange-buyer-label" style={{left:`${at(buyer)[0]/9}%`,top:'79%'}}><span>{buyerLabel}</span><small>{state.kind==='confirmed'?<><Check size={11}/>Order saved</>:conversation.delegate_negotiation===false?'You direct the negotiation':'Negotiates within your rules'}</small></div>
   {sessions.map((s,i)=>{const offer=sellerOffer(s,now),selected=chosen?.session_id===s.session_id,total=selected?conversation.reservation?.total_cents:offer.total;const history=priceHistory(s);return <button key={s.session_id} className={`exchange-seller-label ${filter===s.session_id?'focused':''} ${selected?'purchased':''}`} style={{left:`${labels[i][0]/9}%`,top:'45%'}} aria-pressed={filter===s.session_id} aria-label={`Show ${s.seller_name} activity`} onClick={()=>onSelect(filter===s.session_id?'all':s.session_id)}><strong>{s.seller_name}</strong><span>{total!==undefined?money(total):'Preparing offer'}<small>{selected?(state.kind==='confirmed'?'Purchased':'Selected'):state.kind==='confirmed'?'Not selected':s.status==='declined'?'Declined':offer.expired?'Expired':s.status!=='open'?'Closed':history.length?'Latest offer':'Waiting'}</small></span></button>;})}
  </div></div>
  <footer><span className="exchange-pan-hint">Swipe for sellers →</span><span className="exchange-last">{latest?<><b>{latest.m.by==='platform'?'Exchangent':latest.m.by==='buyer'?(conversation.delegate_negotiation===false?'You':'Your agent'):latest.s.seller_name}</b> {latest.m.kind==='counter'?'countered':latest.m.kind==='declined'?'declined':'offered'}{latest.m.total_cents!==undefined?` ${money(latest.m.total_cents)}`:''}</>:conversation.sessions.length?'Waiting for seller offers':'No matching sellers'}</span><div>{filter!=='all'&&<button className="exchange-reset" onClick={()=>onSelect('all')}>All sellers</button>}{pages>1&&<><button aria-label="Previous sellers" disabled={safePage===0} onClick={()=>{onSelect('all');setPage(p=>Math.max(0,p-1));}}><ArrowLeft size={13}/></button><span>{safePage+1}/{pages}</span><button aria-label="Next sellers" disabled={safePage===pages-1} onClick={()=>{onSelect('all');setPage(p=>Math.min(pages-1,p+1));}}><ArrowRight size={13}/></button></>}</div></footer>
 </section>;
}
