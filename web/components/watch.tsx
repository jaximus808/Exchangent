'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowDownRight,ArrowLeft,ArrowRight,ArrowUpRight,AudioLines,Bot,Check,CheckCircle2,ChevronRight,Expand,LayoutDashboard,LockKeyhole,RefreshCw,ShieldCheck,ShoppingBag,Store,X} from 'lucide-react';
import {ago,duration,firstAt,lastAt,messageCount,type Conversation} from '@/lib/conversation';
import {orderLink,selectedSeller,sellerOffer,watchState,watchAccess} from '@/lib/watch-view';
import {api,ApiError,money} from '@/lib/workspace';
import {SignInForm} from './sign-in';
import {NegotiationMap} from './negotiation-map';
import {OfferRace} from './offer-race';
import {PurchaseFinish} from './purchase-finish';
import {ActivityReceipt} from './activity-receipt';
import {checkpoint,checkpointKey,restoreNotice} from '@/lib/recovery';
import type {OrderStatus} from '@/lib/workspace';
import {PriceTrend} from './price-trend';
import {priceHistory} from '@/lib/price-history';
import '@/app/watch/watch.css';

const initials=(name:string)=>name.split(/\s+/).filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase();
const clock=(value:string)=>new Date(value).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
function Brand(){return <a className="watch-brand" href="/" aria-label="Exchangent dashboard"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8h14m-4-4 4 4-4 4M19 16H5m4-4-4 4 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>exchangent<span>.</span></a>;}
function Access({children}:{children:React.ReactNode}){return <div className="watch"><header className="watch-access-head"><Brand/></header><main className="watch-access">{children}</main></div>;}
export function WatchInvalid(){return <Access><h1>Request not found.</h1><p>Open a negotiation from your buying workspace.</p><a className="watch-action" href="/#buying"><ArrowLeft size={15}/>Back to buying</a></Access>;}
export function WatchSignedOut({configured}:{configured:boolean}){return <Access><LockKeyhole size={24}/><h1>Your agents. One shared view.</h1><p>Sign in with your buyer email to continue.</p><div className="watch-signin">{configured?<SignInForm cta="Open negotiation"/>:<p role="alert">Sign-in is unavailable. Try again shortly.</p>}</div></Access>;}

function Offers({conversation,now,filter,onSelect}:{conversation:Conversation;now:number;filter:string;onSelect:(id:string)=>void}) {
 const purchased=selectedSeller(conversation),state=watchState(conversation,now);
 const priceMax=Math.max(1,...conversation.sessions.flatMap(s=>priceHistory(s).map(p=>p.cents)));
 const sorted=[...conversation.sessions].sort((a,b)=>Number(!sellerOffer(a,now).eligible)-Number(!sellerOffer(b,now).eligible)||(sellerOffer(a,now).total??Infinity)-(sellerOffer(b,now).total??Infinity));
 const eligible=sorted.filter(s=>sellerOffer(s,now).eligible);
 const lowest=eligible.length?Math.min(...eligible.map(s=>sellerOffer(s,now).total!)):null;
 return <section className="watch-offers" aria-labelledby="offers-heading"><div className="watch-section-head"><h2 id="offers-heading">Offers <span>{sorted.length}</span></h2><span>All-in prices</span></div>
  {sorted.length?<div className="watch-offer-grid">{sorted.map(s=>{
   const o=sellerOffer(s,now),selected=purchased?.session_id===s.session_id,total=selected&&conversation.reservation?conversation.reservation.total_cents:o.total,saved=o.opening!==undefined&&total!==undefined?o.opening-total:0;
   const label=selected?(state.kind==='confirmed'?'Purchased':'Selected'):state.kind==='confirmed'?'Not selected':s.status==='declined'?'Declined':s.status!=='open'?'Closed':o.expired?'Expired':o.eligible&&o.total===lowest?'Lowest offer':o.total===undefined?'Preparing':state.live?'Negotiating':'Not selected';
   return <article key={s.session_id} className={`watch-offer-card ${selected?'chosen':''} ${filter===s.session_id?'focused':''}`}>
    <button className="watch-offer-pick" aria-label={`Show ${s.seller_name} activity`} aria-pressed={filter===s.session_id} onClick={()=>onSelect(filter===s.session_id?'all':s.session_id)}><span className="watch-offer-identity"><span className="watch-avatar">{initials(s.seller_name)}</span><strong>{s.seller_name}</strong></span><ChevronRight size={14}/></button>
    <div className="watch-offer-numbers"><strong>{total!==undefined?money(total):'—'}</strong>{saved>0&&<del aria-label={`Opening price ${money(o.opening!)}`}>{money(o.opening!)}</del>}</div>
    <div className="watch-offer-meter" aria-hidden="true"><span style={{width:`${Math.max(0,Math.min(100,(total??0)/priceMax*100))}%`}}/></div>
    <div className="watch-offer-caption"><span className={`watch-row-state ${selected?'selected':''}`}>{selected&&<Check size={11}/>} {label}</span>{saved>0&&<span className="watch-saving"><ArrowDownRight size={12}/>{Math.round(saved/o.opening!*100)}%</span>}</div>
    <PriceTrend session={s} compact maxCents={priceMax}/>
   </article>;
  })}</div>:<div className="watch-offer-empty"><Store size={23}/><span>{state.live?'Waiting for sellers':'No matching sellers'}</span>{state.live&&<span className="watch-wait-dots" aria-hidden="true"><i/><i/><i/></span>}</div>}
 </section>;
}

function Activity({conversation,now,filter,onFilter}:{conversation:Conversation;now:number;filter:string;onFilter:(id:string)=>void}) {
 const[expanded,setExpanded]=useState(false);
 const scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
 const events=conversation.sessions.filter(s=>filter==='all'||s.session_id===filter).flatMap(s=>s.messages.filter(m=>m.kind!=='opened').map((m,i)=>({s,m,key:`${s.session_id}-${m.offer_id??m.counter_id??`${m.kind}-${m.at}-${i}`}`}))).sort((a,b)=>Date.parse(a.m.at)-Date.parse(b.m.at)||a.key.localeCompare(b.key));
 const visible=expanded?events:events.slice(-3),active=watchState(conversation,now).live;
 useEffect(()=>{follow.current=true;},[filter,expanded]);
 useEffect(()=>{const el=scroll.current;if(el&&follow.current&&expanded)el.scrollTo({top:el.scrollHeight,behavior:'auto'});},[events.length,filter,expanded]);
 return <section className="watch-activity compact-activity" aria-labelledby="activity-heading"><div className="watch-section-head"><h2 id="activity-heading">Latest moves <span>{events.length}</span></h2><label className="watch-filter"><span className="watch-sr-only">Filter activity by seller</span><select value={filter} onChange={e=>onFilter(e.target.value)}><option value="all">All sellers</option>{conversation.sessions.map(s=><option key={s.session_id} value={s.session_id}>{s.seller_name}</option>)}</select></label></div>
  <div className={`watch-events ${expanded?'expanded':''}`} ref={scroll} tabIndex={expanded?0:undefined} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<60;}}>
   {visible.length?<ol>{visible.map(({s,m,key})=>{const buyer=m.by==='buyer',declined=m.kind==='declined';return <li className={`watch-event ${buyer?'buyer':'seller'} ${declined?'declined':''}`} key={key}>
    <span className="watch-event-avatar" aria-hidden="true">{buyer?<Bot size={15}/>:initials(s.seller_name)}</span><div className="watch-event-body"><div className="watch-move-top"><strong>{m.by==='platform'?'Exchangent':buyer?(conversation.delegate_negotiation===false?'You':'Your agent'):s.seller_name}</strong>{m.total_cents!==undefined&&<b>{money(m.total_cents)}</b>}</div><div className="watch-move-meta"><span>{declined?'Declined':m.kind==='counter'?`Counter to ${s.seller_name}`:m.version===1?'Opening offer':'Seller offer'}</span><time dateTime={m.at} title={clock(m.at)}>{ago(m.at,now)}</time></div>
    {(m.note||m.reason||m.delivery)&&<details className="watch-move-details"><summary>Message & delivery</summary>{(m.note||m.reason)&&<p>{m.reason||m.note}</p>}{m.delivery&&<span>{m.delivery.transport==='inkbox'?'Inkbox A2A':m.delivery.transport==='local'?'In-process delivery':'Delivery recorded'}{m.delivery.from_handle&&m.delivery.to_handle?` · ${m.delivery.from_handle} → ${m.delivery.to_handle}`:''}{m.delivery.message_id?` · ${m.delivery.message_id.slice(0,8)}`:''}</span>}</details>}
    </div></li>;})}</ol>:<div className="watch-empty"><AudioLines size={24}/><h3>{active?'No moves yet':'No recorded moves'}</h3>{active&&<span className="watch-wait-dots" aria-hidden="true"><i/><i/><i/></span>}</div>}
  </div>{events.length>3&&<button className="watch-history-toggle" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>{expanded?'Show latest moves':`Full history · ${events.length} moves`}<ChevronRight size={13}/></button>}
 </section>;
}

export function Watch({requestId,email}:{requestId:string;email:string}) {
 const[conv,setConv]=useState<Conversation|null>(null),[filter,setFilter]=useState('all');
 const[error,setError]=useState<{code:string;message:string}|null>(null),[stale,setStale]=useState(false),[now,setNow]=useState(()=>Date.now());
 const[receipt,setReceipt]=useState<OrderStatus|null>(null),[restored,setRestored]=useState<{newMoves:number;seenAt:number}|null>(null);
 const checkpointScope=useRef('');
 useEffect(()=>{if(!conv||conv.request_id!==requestId)return;const key=checkpointKey(email,requestId);try{if(checkpointScope.current!==key){setRestored(restoreNotice(localStorage.getItem(key),conv,email));checkpointScope.current=key;}const saved=checkpoint(conv,email);if(saved)localStorage.setItem(key,JSON.stringify(saved));else localStorage.removeItem(key);}catch{/* Server recovery works even when browser storage is unavailable. */}},[conv,email,requestId]);
 const reload=useRef<()=>void>(()=>{});
 useEffect(()=>{if(conv&&filter!=='all'&&!conv.sessions.some(s=>s.session_id===filter))setFilter('all');},[conv,filter]);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,inFlight=false;
  async function tick(){
   if(controller.signal.aborted||inFlight)return;
   if(document.visibilityState==='hidden'){timer=setTimeout(()=>void tick(),10000);return;}
   inFlight=true;if(timer)clearTimeout(timer);let terminal=false,active=false;
   try{const data=await api<Conversation>(`buy-requests/${requestId}/conversation`,{signal:controller.signal});if(controller.signal.aborted)return;active=data.status==='negotiating';setConv(data);setError(null);setStale(false);}
   catch(e){if(controller.signal.aborted)return;if(e instanceof ApiError&&[401,403,404].includes(e.status)){terminal=true;setError({code:watchAccess(e.status)!,message:e.message});}else setStale(true);}
   finally{inFlight=false;if(!controller.signal.aborted&&!terminal)timer=setTimeout(()=>void tick(),active?1500:10000);}
  }
  reload.current=()=>void tick();const visible=()=>{if(document.visibilityState==='visible')void tick();};
  document.addEventListener('visibilitychange',visible);void tick();
  return()=>{controller.abort();if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visible);reload.current=()=>{};};
 },[requestId]);
 if(error?.code==='not_found')return <WatchInvalid/>;
 if(error)return <Access>{error.code==='signed_out'?<><h1>Your session ended.</h1><p>Sign in to resume this negotiation.</p><div className="watch-signin"><SignInForm cta="Resume negotiation" onDone={()=>{setConv(null);setError(null);reload.current();}}/></div></>:<><h1>This request is private.</h1><p>Sign in with the account that placed it.</p><a className="watch-action" href="/#buying">Back to buying<ArrowRight size={15}/></a></>}</Access>;
 const state=watchState(conv,now),chosen=selectedSeller(conv),link=orderLink(requestId);
 const eligible=conv?.sessions.filter(s=>sellerOffer(s,now).eligible).sort((a,b)=>sellerOffer(a,now).total!-sellerOffer(b,now).total!)??[];
 const candidate=chosen??eligible[0]??null,offer=candidate?sellerOffer(candidate,now):null;
 const reservation=conv?.reservation&&['held','checkout_open','payment_pending','consumed'].includes(conv.reservation.status)?conv.reservation:null;
 const total=reservation?.total_cents??offer?.total;
 const saved=offer?.opening!==undefined&&total!==undefined?offer.opening-total:0;
 const started=firstAt(conv),ended=conv&&!state.live?lastAt(conv):null;
 const hops=conv?.sessions.reduce((n,s)=>n+s.messages.filter(m=>m.delivery?.transport==='inkbox').length,0)??0;
 return <div className="watch">
  <aside className="watch-sidebar"><Brand/><span className="watch-workspace"><span className="watch-avatar">{email.slice(0,1).toUpperCase()}</span><span>Personal workspace<small>Buyer account</small></span></span>
   <nav aria-label="Workspace"><a href="/"><LayoutDashboard size={17}/>Overview</a><a href="/#buying"><ShoppingBag size={17}/>Buying</a><a href="/#selling"><Store size={17}/>Selling</a><a href="#watch-content" className="current" aria-current="page"><AudioLines size={17}/>Live negotiation</a></nav>
   <div className="watch-sidebar-bottom"><ShieldCheck size={16}/><span>Agents negotiate.<br/>You approve payment.</span></div><span className="watch-account" title={email}>{email}</span>
  </aside>
  <div className="watch-workspace-main"><header className="watch-top"><nav aria-label="Breadcrumb"><a href="/#buying">Buying</a><ChevronRight size={13}/><span>Live negotiation</span></nav><div className="watch-top-actions"><span className={`watch-connection ${state.live&&!stale?'live':''}`}><span/>{stale?'Reconnecting':state.live?'Live updates':state.kind==='loading'?'Connecting':'Up to date'}</span><button className="watch-icon" onClick={()=>reload.current()} aria-label="Refresh negotiation"><RefreshCw size={15}/></button><button className="watch-icon" onClick={()=>void document.documentElement.requestFullscreen?.().catch(()=>{})} aria-label="Full screen"><Expand size={15}/></button></div></header>
   <main className="watch-main" id="watch-content"><header className="watch-heading"><div><a className="watch-back" href="/#buying"><ArrowLeft size={13}/>Your requests</a><h1>{conv?.title||'Your negotiation'}</h1><div className="watch-context"><span className={`watch-phase ${state.kind}`}><span/>{state.label}</span><span>{conv?.sessions.length??0} sellers</span><span>{messageCount(conv)} messages</span>{started&&<span>{duration((ended??now)-started)} elapsed</span>}</div></div><a className={`watch-action secondary ${['confirmed','review','approval'].includes(state.kind)?'needs-human':''}`} href={link}>{state.kind==='confirmed'?'View order':state.kind==='review'?'Review offers':state.kind==='approval'?'Review & pay':'Open request'}<ArrowUpRight size={15}/></a></header>
    {stale&&<div className="watch-reconnect" role="alert">Connection interrupted. Showing your last saved activity.<button onClick={()=>reload.current()}>Try again</button></div>}
    {restored&&<div className="view-restored" role="status"><RefreshCw size={15}/><span><strong>Saved request restored</strong><small>{restored.newMoves?`${restored.newMoves} new recorded ${restored.newMoves===1?'move':'moves'}`:'Showing the latest saved state'}</small></span><button onClick={()=>setRestored(null)} aria-label="Dismiss recovery notice"><X size={13}/></button></div>}
    {conv&&<PurchaseFinish key={requestId} conversation={conv} onReceipt={setReceipt}/>}
    <div className="watch-layout"><div className="watch-primary">
     {!conv?<div className="watch-loading visual-loading" role="status"><span className="watch-loading-shape" aria-hidden="true"><i/><i/><i/></span><span>Connecting to your agents</span></div>:<><NegotiationMap conversation={conv} now={now} filter={filter} onSelect={setFilter} connected={!stale}/><OfferRace conversation={conv} now={now} filter={filter} onSelect={setFilter} connected={!stale}/><Offers conversation={conv} now={now} filter={filter} onSelect={setFilter}/><ActivityReceipt conversation={conv} receipt={receipt} now={now}/><Activity conversation={conv} now={now} filter={filter} onFilter={setFilter}/></>}
    </div><aside className="watch-summary" aria-label="Negotiation summary"><section className="watch-outcome">
     <div className={`watch-outcome-icon ${state.kind}`} aria-hidden="true">{state.kind==='confirmed'?<CheckCircle2 size={22}/>:state.kind==='approval'?<LockKeyhole size={22}/>:<AudioLines size={22}/>}</div>
     <h2>{state.kind==='confirmed'?'Order confirmed':state.kind==='verifying'?'Verifying payment':state.kind==='approval'?'Ready for payment':state.kind==='review'?'Offers ready for review':state.live?'Negotiation in progress':'Negotiation summary'}</h2>
     {candidate&&<p className="watch-summary-seller">{candidate.seller_name}</p>}
     {total!==undefined&&<strong className="watch-summary-price">{money(total)}<small>{state.kind==='confirmed'?'Total paid':reservation?'Reserved total':'Lowest current offer'}</small></strong>}
     {saved>0&&<span className="watch-summary-saving"><ArrowDownRight size={14}/>{money(saved)} {state.kind==='confirmed'?'saved':'below opening'}</span>}
     <p>{state.kind==='confirmed'?'Payment verified':state.kind==='verifying'?'No action needed. Don’t pay again.':state.kind==='approval'?'Items held · approval needed':state.kind==='review'?'Review when you’re ready':conv&&!conv.sessions.length?'Adjust your request in your assistant':state.kind==='ended'?'Check the latest request status':conv?.delegate_negotiation===false?'Continue in your assistant':'No action needed'}</p>
     <a className="watch-action" href={link}>{state.kind==='confirmed'?'View your order':state.kind==='approval'?'Review & pay':state.kind==='review'?'Review offers':'View request'}<ArrowRight size={15}/></a>
    </section><section className="watch-process compact-process" aria-label="Purchase progress"><ol>{['Matched','Negotiate','Approve','Paid'].map((label,i)=><li key={label} className={state.kind==='ended'?'':i<state.step||state.kind==='confirmed'?'done':i===state.step?'active':''} aria-current={state.kind!=='ended'&&i===state.step?'step':undefined}><span>{i<state.step||state.kind==='confirmed'?<Check size={12}/>:<span/>}</span><small>{label}</small></li>)}</ol></section>
    </aside></div>
    <footer className="watch-foot"><span><ShieldCheck size={13}/>Private to your buyer account</span><span>{hops>0?`${hops} Inkbox deliveries`:'Recorded agent activity'} · Test payments</span></footer>
   </main>
  </div>
 </div>;
}
