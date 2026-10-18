'use client';
import {useEffect,useRef,useState} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {ChartNoAxesCombined,Check,ChevronRight} from 'lucide-react';
import type {Conversation} from '@/lib/conversation';
import {offerRace} from '@/lib/offer-race';
import {selectedSeller,sellerOffer} from '@/lib/watch-view';
import {money} from '@/lib/workspace';
import './offer-race.css';

// Muted ink colors plus distinct dash patterns: identity never relies on color alone.
const inks=['#5a7b69','#647b9c','#947d67','#806e93','#5c858b','#8a6c74'];
const dashes=['','7 4','2 4','9 3 2 3','12 5','4 3'];
export function OfferRace({conversation,now,filter,onSelect,connected=true}:{conversation:Conversation;now:number;filter:string;onSelect:(id:string)=>void;connected?:boolean}) {
 const container=useRef<HTMLDivElement>(null),[width,setWidth]=useState(720),[move,setMove]=useState<{session:string;id:string}|null>(null);
 const previousWidth=useRef(width),resized=previousWidth.current!==width;
 useEffect(()=>{previousWidth.current=width;},[width]);
 const reduced=useReducedMotion(),model=offerRace(conversation.sessions,width),chosen=selectedSeller(conversation);
 useEffect(()=>{const el=container.current;if(!el)return;const observer=new ResizeObserver(([entry])=>setWidth(Math.max(280,Math.round(entry.contentRect.width))));observer.observe(el);return()=>observer.disconnect();},[]);
 const all=model.series.flatMap(s=>s.points.map(p=>({s,p}))),selected=filter===move?.session?all.find(p=>p.s.session.session_id===move?.session&&p.p.id===move?.id):undefined;
 const focus=filter==='all'?null:model.series.find(s=>s.session.session_id===filter);
 const latest=selected??(focus?focus.points.map(p=>({s:focus,p})).at(-1):[...all].sort((a,b)=>Date.parse(b.p.at)-Date.parse(a.p.at))[0]);
 const message=selected?.s.session.messages.find(m=>m.kind==='offer'&&m.by==='seller'&&(m.offer_id===selected.p.id||(m.at===selected.p.at&&m.total_cents===selected.p.cents)));
 const choose=(session:string,id:string)=>{setMove({session,id});onSelect(session);};
 const rounds=model.rounds<=5?Array.from({length:model.rounds},(_,i)=>i):[0,Math.floor((model.rounds-1)/2),model.rounds-1];
 return <section className="offer-race" aria-labelledby="offer-race-title">
  <header><div><ChartNoAxesCombined size={15}/><h2 id="offer-race-title">Offer race</h2></div><span>{connected?'Seller offers only':'Reconnecting · saved offers'}</span></header>
  <div className="race-plot" ref={container}>
   {all.length?<svg viewBox={`0 0 ${width} 248`} width={width} height="248" role="group" aria-label="Seller price chart. Horizontal axis: each seller’s offer number. Vertical axis: total price in dollars.">
    {model.ticks.map(t=><g key={t.cents}><line x1={model.left} x2={model.right} y1={t.y} y2={t.y} className="race-grid"/><text x={model.left-10} y={t.y+3} textAnchor="end" className="race-tick">{money(t.cents).replace(/\.00$/,'')}</text></g>)}
    {rounds.map(i=><text key={i} x={model.left+(model.right-model.left)*i/Math.max(1,model.rounds-1)} y="224" textAnchor="middle" className="race-tick">{i===0?'Opening':`Offer ${i+1}`}</text>)}
    {model.series.map((s,i)=>{const id=s.session.session_id,dim=filter!=='all'&&filter!==id,color=inks[i%inks.length],end=s.points.at(-1);return <g key={id} className={`race-series ${dim?'dimmed':''}`} style={{color}}>
     <path d={s.points.map((p,j)=>`${j?'L':'M'}${p.x},${p.y}`).join(' ')} strokeDasharray={dashes[i%dashes.length]} className="race-line"/>
     {end&&<motion.circle key="endpoint" initial={false} animate={{cx:end.x,cy:end.y}} transition={{duration:reduced||resized?0:.65,ease:[.2,.7,.2,1]}} r="8" className="race-end-ring"/>}
     {s.points.map(p=>{const active=selected?.p.id===p.id&&selected?.s.session.session_id===id;return <g key={p.id}>
      <circle cx={p.x} cy={p.y} r={active?5:3.5} className="race-dot"/>
      <circle cx={p.x} cy={p.y} r="12" className="race-hit" role="button" tabIndex={dim?-1:0} aria-label={`${s.session.seller_name}, ${p.round===1?'opening':`offer ${p.round}`}, ${money(p.cents)}. Show this move.`} aria-pressed={active} onClick={()=>choose(id,p.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choose(id,p.id);}}}><title>{s.session.seller_name}: {money(p.cents)}</title></circle>
     </g>;})}
    </g>;})}
   </svg>:<div className="race-empty"><ChartNoAxesCombined size={28}/><span>Waiting for the first seller offer</span></div>}
  </div>
  <div className="race-legend" aria-label="Compare sellers">{model.series.map((s,i)=>{const id=s.session.session_id,p=s.points.at(-1),offer=sellerOffer(s.session,now),picked=chosen?.session_id===id;return <button key={id} className={filter===id?'active':''} style={{'--race-ink':inks[i%inks.length]} as React.CSSProperties} aria-pressed={filter===id} onClick={()=>{setMove(null);onSelect(filter===id?'all':id);}}>
   <svg width="22" height="10" aria-hidden="true"><path d="M1 5H21" stroke="var(--race-ink)" strokeWidth="2" strokeDasharray={dashes[i%dashes.length]}/></svg><span><strong>{s.session.seller_name}</strong><small>{picked?<><Check size={10}/>{conversation.status==='confirmed'?'Purchased':'Selected'}</>:s.session.status==='declined'?'Declined':offer.expired?'Expired':s.session.status!=='open'?'Closed':p?'Last recorded':'No offer yet'}</small></span><b>{p?money(p.cents):'—'}</b>
  </button>;})}</div>
  <footer>{latest?<div className="race-readout" role="status"><span>{latest.s.session.seller_name}<small>{latest.p.round===1?'Opening':`Offer ${latest.p.round}`} · {new Date(latest.p.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</small></span><strong>{money(latest.p.cents)}</strong><label><span className="watch-sr-only">Inspect recorded offer</span><select value={`${latest.s.session.session_id}|${latest.p.id}`} onChange={e=>{const found=all.find(p=>`${p.s.session.session_id}|${p.p.id}`===e.target.value);if(found)choose(found.s.session.session_id,found.p.id);}}>{all.map(({s,p})=><option key={`${s.session.session_id}-${p.id}`} value={`${s.session.session_id}|${p.id}`}>{s.session.seller_name} · {p.round===1?'Opening':`Offer ${p.round}`} · {money(p.cents)}</option>)}</select></label></div>:<span>Offers appear as sellers respond.</span>}{filter!=='all'&&<button className="race-reset" onClick={()=>{setMove(null);onSelect('all');}}>Compare all<ChevronRight size={12}/></button>}</footer>
 {selected&&message?.note&&<details className="race-note" key={`${selected.s.session.session_id}-${selected.p.id}`}><summary>View offer message</summary><p>{message.note}</p></details>}
 </section>;
}
