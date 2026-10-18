'use client';
import {useEffect,useRef,useState} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ArrowDownRight,ArrowLeft,Bot,CheckCircle2,Expand,Moon,PartyPopper,Sun,TimerReset,UserRound} from 'lucide-react';
import {agreedDeal,bestOffer,currentOffer,duration,firstAt,lastAt,messageCount,type ConvSession,type Conversation} from '@/lib/conversation';
import {api,ApiError,money} from '@/lib/workspace';
import {SignInForm} from './sign-in';
import {Thread} from './thread';
import '@/app/watch/watch.css';

const NEGOTIATING_MS=1500,SETTLED_MS=10000;
type Theme='dark'|'light';

function Brand() {
 return <a className="watch-brand" href="/" aria-label="Exchangent dashboard"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 8h14m-4-4 4 4-4 4M19 16H5m4-4-4 4 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg><span>exchangent<span className="watch-period">.</span></span></a>;
}
function useTheme():[Theme,()=>void] {
 const[theme,setTheme]=useState<Theme>('dark');
 useEffect(()=>{try{const t=localStorage.getItem('exchangent-watch-theme');if(t==='light'||t==='dark')setTheme(t);}catch{/* storage blocked */}},[]);
 return [theme,()=>setTheme(t=>{const next=t==='dark'?'light':'dark';try{localStorage.setItem('exchangent-watch-theme',next);}catch{/* storage blocked */}return next;})];
}
function Shell({theme,children}:{theme:Theme;children:React.ReactNode}) {return <div className={`watch watch-${theme}`}>{children}</div>;}

export function WatchInvalid() {
 return <Shell theme="dark"><main className="watch-center"><Brand/><h1>This link isn’t a negotiation.</h1><p>Open “Watch agents” from a request in your dashboard.</p><a className="watch-button" href="/"><ArrowLeft size={15}/>Back to dashboard</a></main></Shell>;
}
export function WatchSignedOut({configured}:{configured:boolean}) {
 return <Shell theme="dark"><main className="watch-center"><Brand/><h1>Sign in to watch your agents.</h1><p>Use the email you buy with. You’ll come straight back to the live negotiation.</p>
  <div className="watch-signin">{configured?<SignInForm cta="Watch the negotiation"/>:<p className="form-error">Sign-in isn’t configured on this server.</p>}</div></main></Shell>;
}

const initials=(name:string)=>name.split(/\s+/).filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase();
function sessionState(s:ConvSession,delegated:boolean) {
 if(s.status==='declined') return 'Declined';
 if(s.status!=='open') return 'Closed';
 if(!s.messages.some(m=>m.kind==='offer')) return s.seller_agent===false?`${s.seller_name} is reviewing`:'Seller agent is preparing an offer';
 return s.turn==='buyer'?(delegated?'Your agent’s move':'Your move'):(s.seller_agent===false?'Seller’s move':'Seller agent’s move');
}

function Column({session,conversation,now,leading,deal}:{session:ConvSession;conversation:Conversation;now:number;leading:boolean;deal:boolean}) {
 const scroller=useRef<HTMLDivElement>(null);
 const offers=session.messages.filter(m=>m.kind==='offer');
 const opening=offers[0]?.total_cents,current=currentOffer(session)?.total_cents;
 const saved=opening!==undefined&&current!==undefined?opening-current:0;
 useEffect(()=>{const el=scroller.current;if(el)el.scrollTo({top:el.scrollHeight,behavior:'smooth'});},[session.messages.length]);
 return <section className={`watch-column ${leading?'leading':''} ${deal?'deal':''} ${session.status!=='open'?'closed':''}`} aria-label={`Negotiation with ${session.seller_name}`}>
  <header className="column-head">
   <span className="seller-badge" aria-hidden="true">{initials(session.seller_name)}</span>
   <div className="column-title"><h2>{session.seller_name}</h2><span>{session.seller_agent===false?<><UserRound size={12}/>Owner negotiating in chat</>:<><Bot size={12}/>{session.seller_handle?`@${session.seller_handle}`:'Seller agent'}</>}</span></div>
   {deal?<span className="column-flag deal"><CheckCircle2 size={13}/>Deal</span>:leading?<span className="column-flag">Best price</span>:null}
  </header>
  <div className="column-price">
   <div><span className="label">Current offer</span><strong>{current!==undefined?money(current):'—'}</strong></div>
   <div className="column-meta">{saved>0&&<span className="saved"><ArrowDownRight size={13}/>{money(saved)} off {money(opening!)}</span>}<span>Round {session.rounds??0} · {sessionState(session,conversation.delegate_negotiation!==false)}</span></div>
  </div>
  <div className="column-thread" ref={scroller}><Thread session={session} conversation={conversation} perspective="buyer" now={now}/></div>
 </section>;
}

export function Watch({requestId,email}:{requestId:string;email:string}) {
 const reduced=useReducedMotion();
 const[theme,toggleTheme]=useTheme();
 const[conv,setConv]=useState<Conversation|null>(null);
 const[error,setError]=useState<{code:string;message:string}|null>(null);
 const[now,setNow]=useState(()=>Date.now());
 const[stale,setStale]=useState(false);
 const status=useRef('negotiating');
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
 useEffect(()=>{
  let alive=true,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{
   try {
    const data=await api<Conversation>(`buy-requests/${requestId}/conversation`);
    if(!alive) return;
    status.current=data.status;setConv(data);setError(null);setStale(false);
   } catch(e) {
    if(!alive) return;
    if(e instanceof ApiError&&[401,403,404].includes(e.status)) {setError({code:e.status===401?'signed_out':'not_yours',message:e.message});return;}
    setStale(true);
   }
   if(alive) timer=setTimeout(tick,status.current==='negotiating'?NEGOTIATING_MS:SETTLED_MS);
  };
  void tick();
  return()=>{alive=false;if(timer)clearTimeout(timer);};
 },[requestId]);

 if(error) return <Shell theme={theme}><main className="watch-center"><Brand/>{error.code==='signed_out'?<><h1>Your session ended.</h1><p>Sign in again to keep watching.</p><div className="watch-signin"><SignInForm cta="Watch the negotiation"/></div></>:<><h1>This negotiation isn’t in your workspace.</h1><p>You’re signed in as {email}. Only the buyer who placed a request can watch its agents.</p><a className="watch-button" href="/"><ArrowLeft size={15}/>Back to dashboard</a></>}</main></Shell>;

 const best=bestOffer(conv),deal=agreedDeal(conv);
 const started=firstAt(conv),ended=conv&&conv.status!=='negotiating'?lastAt(conv):null;
 const sessions=[...(conv?.sessions??[])].sort((a,b)=>(a.status==='open'?0:1)-(b.status==='open'?0:1));
 const hops=(conv?.sessions??[]).reduce((n,s)=>n+s.messages.filter(m=>m.delivery?.transport==='inkbox').length,0);
 const live=conv?.status==='negotiating';
 const phase=conv?.status==='confirmed'?'Paid · order confirmed':conv?.status==='awaiting_payment'?'Reserved · awaiting payment':deal?'Deal reached':live?'Agents negotiating':'Settled';
 return <Shell theme={theme}>
  <header className="watch-top">
   <Brand/>
   <div className="watch-top-actions">
    {stale&&<span className="watch-stale">Reconnecting…</span>}
    <span className={`live-pill ${live?'on':''}`}><span className="live-dot"/>{live?'Live':'Paused'}</span>
    <button className="watch-icon" onClick={toggleTheme} aria-label={`Switch to ${theme==='dark'?'light':'dark'} theme`}>{theme==='dark'?<Sun size={16}/>:<Moon size={16}/>}</button>
    <button className="watch-icon" onClick={()=>void document.documentElement.requestFullscreen?.().catch(()=>{})} aria-label="Full screen"><Expand size={16}/></button>
   </div>
  </header>
  <main className="watch-main">
   <section className="watch-hero">
    <div className="hero-copy"><span className="eyebrow">{phase}</span><h1>{conv?.title||'Your request'}</h1><p>Your buying agent and each seller’s agent message each other over Inkbox. Exchangent checks every price against stock, floors and your budget before it counts.</p></div>
    <dl className="hero-stats">
     <div className="stat best"><dt>Best offer</dt><dd>{best?.offer.total_cents!==undefined?money(best.offer.total_cents):'—'}</dd><small>{best?best.session.seller_name:'Waiting for offers'}</small></div>
     <div className="stat"><dt>Elapsed</dt><dd>{started?duration((ended??now)-started):'—'}</dd><small>{live?'and counting':'total'}</small></div>
     <div className="stat"><dt>Messages</dt><dd>{messageCount(conv)}</dd><small>{hops} over Inkbox A2A</small></div>
     <div className="stat"><dt>Sellers</dt><dd>{conv?.sessions.length??'—'}</dd><small>{conv?.delegate_negotiation===false?'You negotiate in chat':'Your agent negotiates'}</small></div>
    </dl>
   </section>
   <AnimatePresence>{(deal||conv?.status==='awaiting_payment'||conv?.status==='confirmed')&&<motion.div className={`deal-banner ${conv?.status==='confirmed'?'paid':''}`} initial={reduced?false:{opacity:0,y:-10}} animate={{opacity:1,y:0}} exit={{opacity:0}}>
    {conv?.status==='confirmed'?<CheckCircle2 size={22}/>:<PartyPopper size={22}/>}
    <div><strong>{conv?.status==='confirmed'?'Paid. The order is confirmed.':conv?.status==='awaiting_payment'?'Reserved. Waiting for your payment.':`Deal reached with ${deal!.session.seller_name}: ${money(deal!.offer.total_cents!)}`}</strong>
     <span>{conv?.status==='confirmed'?'The seller has been told it sold.':conv?.status==='awaiting_payment'?'Complete the Stripe test checkout to finish.':'Your agent stopped here and emailed you. Nothing is reserved or charged until you approve it.'}</span></div>
   </motion.div>}</AnimatePresence>
   {!conv?<div className="watch-loading" aria-label="Loading negotiation"><span/><span/><span/></div>:sessions.length===0?<div className="watch-empty"><TimerReset size={26}/><h2>Looking for sellers…</h2><p>No business matches this request yet. Sessions appear here the moment one does.</p></div>:
    <div className="watch-columns" style={{'--cols':Math.min(sessions.length,4)} as React.CSSProperties}>
     {sessions.map(s=><Column key={s.session_id} session={s} conversation={conv} now={now} leading={best?.session.session_id===s.session_id} deal={deal?.session.session_id===s.session_id}/>)}
    </div>}
  </main>
  <footer className="watch-foot"><span>Signed in as {email}</span><span>Agents negotiate. You approve every payment.</span></footer>
 </Shell>;
}
