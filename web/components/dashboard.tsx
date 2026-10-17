'use client';

import {useEffect,useRef,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ArrowDownUp,ArrowLeft,ArrowRight,ArrowUpRight,Armchair,Bell,Check,CheckCheck,ChevronDown,ChevronRight,ChevronsUpDown,Clock3,ExternalLink,FileText,HelpCircle,LayoutDashboard,Loader2,LockKeyhole,LogOut,MapPin,Menu,MoreHorizontal,Package,Plus,Search,Settings2,ShieldCheck,SlidersHorizontal,Table2,Truck,Workflow,X} from 'lucide-react';
import {endSession,requestSignIn,verifySignIn} from '@/app/actions';
import {api,demoOffers,demoRequest,money,type BuyRequest,type Offer,type OrderStatus} from '@/lib/workspace';

type User={id:string;email:string};
type View='Overview'|'Requests'|'Your agent'|'Orders'|'Preferences';
type Modal='request'|'auth'|'search'|'help'|null;
const dateLabel=(date:string)=>new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric'});
const requestTitle=(r:BuyRequest)=>r.title??r.requirements.split('\n')[0].slice(0,70)??'New request';
const statusLabel=(status:string)=>({awaiting_payment:'Ready for review',confirmed:'Purchased',negotiating:'Request submitted',draft:'Draft'}[status]??status.replaceAll('_',' '));

function Brand({small=false}:{small?:boolean}) {
 return <span className={`brand ${small?'brand-small':''}`}><span className="brand-symbol" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 8h14m-4-4 4 4-4 4M19 16H5m4-4-4 4 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg></span>{!small&&<span>exchangent<span className="brand-period">.</span></span>}</span>;
}
function AgentMark({small=false}:{small?:boolean}) {return <span className={`agent-mark ${small?'small':''}`} aria-hidden="true"><Workflow size={small?17:22} strokeWidth={1.5}/></span>;}
function Status({children,dot=true}:{children:React.ReactNode;dot?:boolean}) {return <span className="status-pill">{dot&&<span className="status-dot"/>}{children}</span>;}
function Empty({title,children,action}:{title:string;children:React.ReactNode;action?:React.ReactNode}) {return <div className="empty-state"><Package size={30} strokeWidth={1.2}/><h3>{title}</h3><p>{children}</p>{action}</div>;}
function WorkspaceDialog({open,onClose,title,description,children,className=''}:{open:boolean;onClose:()=>void;title:string;description:string;children:React.ReactNode;className?:string}) {
 return <Dialog.Root open={open} onOpenChange={v=>!v&&onClose()}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className={`modal-content ${className}`}><div className="modal-top"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close dialog"><X size={19}/></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
function SignIn({onDone}:{onDone:()=>void}) {
 const[email,setEmail]=useState('');const[code,setCode]=useState('');const[sent,setSent]=useState(false);const[error,setError]=useState('');const[pending,start]=useTransition();
 return <form className="stack-form" onSubmit={e=>{e.preventDefault();setError('');start(async()=>{const result=sent?await verifySignIn(email,code):await requestSignIn(email);if(result.error)setError(result.error);else if(sent)onDone();else setSent(true);});}}>
  <div className="auth-emblem"><Brand small/><LockKeyhole size={19}/></div>
  <p className="form-intro">One workspace for your requests, offers, and purchases. You stay in control of every payment.</p>
  <label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required readOnly={sent}/></label>
  {sent&&<label>Verification code<input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value)} placeholder="000000" autoFocus required/><span className="field-help">We sent a six-digit code to {email}.</span></label>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={pending}>{pending?<Loader2 className="spin" size={17}/>:null}{sent?'Open your workspace':'Email me a sign-in code'}{!pending&&<ArrowRight size={17}/>}</button>
  {sent&&<button type="button" className="text-button centered" disabled={pending} onClick={()=>{setSent(false);setCode('');setError('');}}>Use a different email or request a new code</button>}
  <p className="fine-print">No password to remember. Your payment details stay with Stripe.</p>
 </form>;
}

export function Dashboard({user}:{user:User|null}) {
 const router=useRouter();const preview=!user;const reduced=useReducedMotion();
 const[view,setView]=useState<View>('Overview');const[modal,setModal]=useState<Modal>(null);const[mobileNav,setMobileNav]=useState(false);
 const[requests,setRequests]=useState<BuyRequest[]>(preview?[demoRequest]:[]);const[selected,setSelected]=useState<string>(preview?demoRequest.id:'');
 const[offers,setOffers]=useState<Offer[]>(preview?demoOffers:[]);const[review,setReview]=useState<Offer|null>(null);
 const[loading,setLoading]=useState(!preview);const[busy,setBusy]=useState(false);const[error,setError]=useState('');const[notice,setNotice]=useState('');
 const[search,setSearch]=useState('');const[filter,setFilter]=useState<'All requests'|'Needs you'>('All requests');
 const[sort,setSort]=useState<'recommended'|'price'>('recommended');const[order,setOrder]=useState<OrderStatus|null>(null);
 const[title,setTitle]=useState('');const[brief,setBrief]=useState('');const[budget,setBudget]=useState('400');
 const[location,setLocation]=useState('San Francisco');const[delivery,setDelivery]=useState('This weekend');
 const[formError,setFormError]=useState('');const[pending,startTransition]=useTransition();
 const createKey=useRef<string|null>(null);const reserveKeys=useRef<Record<string,string>>({});
 const active=requests.find(r=>r.id===selected);const budgetCents=active?.budget_cents;
 const selectedOffers=sort==='price'?[...offers].sort((a,b)=>a.total_cents-b.total_cents):offers;
 const reviewCount=requests.filter(r=>r.status==='awaiting_payment').length;
 const nav=(next:View)=>{setView(next);setMobileNav(false);setSearch('');};
 useEffect(()=>{if(!notice)return;const id=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(id);},[notice]);
 useEffect(()=>{
  const shortcut=(e:KeyboardEvent)=>{if((e.metaKey||e.ctrlKey)&&e.key==='k'){e.preventDefault();setModal('search');}};
  window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);
 },[]);
 useEffect(()=>{
  if(preview)return;let alive=true;
  api<BuyRequest[]>('buy-requests').then(rows=>{if(alive){setRequests(rows);setSelected(rows[0]?.id??'');}})
    .catch(e=>alive&&setError(e.message)).finally(()=>alive&&setLoading(false));
  return()=>{alive=false;};
 },[preview]);
 useEffect(()=>{
  if(preview||!selected)return;const controller=new AbortController();setOffers([]);setError('');
  const refresh=async()=>{
   if(document.visibilityState==='hidden')return;
   try {
    const [request,rows]=await Promise.all([api<BuyRequest>(`buy-requests/${selected}`,{signal:controller.signal}),api<Offer[]>(`buy-requests/${selected}/offers`,{signal:controller.signal})]);
    if(!controller.signal.aborted){setRequests(old=>old.map(r=>r.id===request.id?request:r));setOffers(rows);}
   }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Could not refresh this request.');}
  };
  void refresh();const timer=setInterval(refresh,12000);
  return()=>{controller.abort();clearInterval(timer);};
 },[preview,selected]);
 useEffect(()=>{
  if(!user)return;const id=localStorage.getItem(`exchangent-reservation-${user.id}`);if(!id)return;
  const controller=new AbortController();
  const refresh=()=>api<OrderStatus>(`reservations/${id}`,{signal:controller.signal}).then(row=>{if(!controller.signal.aborted)setOrder(row);}).catch(()=>{});
  void refresh();const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh();},12000);
  return()=>{controller.abort();clearInterval(timer);};
 },[user]);
 async function submitRequest(e:React.FormEvent) {
  e.preventDefault();setFormError('');const dollars=Number(budget);
  if(!title.trim()||!brief.trim()||!Number.isFinite(dollars)||dollars<=0||dollars>1000000){setFormError('Add a title, a few details, and a valid budget.');return;}
  const requirements=`${title.trim()}\n${brief.trim()}\nLocation: ${location.trim()}. Delivery: ${delivery.trim()}.`;
  if(requirements.length>4000){setFormError('Please keep your request under 4,000 characters.');return;}
  setBusy(true);
  try {
   let request:BuyRequest;
   if(preview)request={id:`preview-${crypto.randomUUID()}`,title:title.trim(),requirements,budget_cents:Math.round(dollars*100),status:'draft',currency:'usd',created_at:new Date().toISOString()};
   else {
    createKey.current??=crypto.randomUUID();
    request=await api<BuyRequest>('buy-requests',{method:'POST',headers:{'idempotency-key':createKey.current},body:JSON.stringify({requirements,budget_cents:Math.round(dollars*100),currency:'usd'})});
   }
   setRequests(old=>[request,...old.filter(r=>r.id!==request.id)]);setSelected(request.id);setOffers([]);setView('Overview');setModal(null);setTitle('');setBrief('');createKey.current=null;
   setNotice(preview?'Preview draft saved. Sign in when you’re ready to send it.':'Your request is saved. Offers will appear here when businesses respond.');
  }catch(e){setFormError(e instanceof Error?e.message:'Your request couldn’t be saved. Try again.');}
  finally{setBusy(false);}
 }
 async function checkout(offer:Offer) {
  if(preview){setReview(null);setModal('auth');return;}
  setBusy(true);setError('');
  try {
   reserveKeys.current[offer.id]??=crypto.randomUUID();
   const hold=await api<{id:string}>(`offers/${offer.id}/reservations`,{method:'POST',headers:{'idempotency-key':reserveKeys.current[offer.id]}});
   localStorage.setItem(`exchangent-reservation-${user!.id}`,hold.id);
   const payment=await api<{url:string;session_id:string}>(`reservations/${hold.id}/checkout`,{method:'POST'});
   const url=new URL(payment.url);
   if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||!payment.session_id.startsWith('cs_test_'))throw new Error('This checkout link could not be verified. Please refresh your request.');
   window.location.assign(url.toString());
  }catch(e){setError(e instanceof Error?e.message:'Checkout couldn’t be opened. Check your request and try again.');setReview(null);}
  finally{setBusy(false);}
 }
 const events=preview&&active?.id===demoRequest.id?[
  {title:'Your brief, understood',detail:'Desk + chair · up to $400 · delivered this weekend',time:'10:30',icon:FileText},
  {title:'Three businesses matched',detail:'Available stock, delivery area, and your requirements checked.',time:'10:31',icon:Search},
  {title:'A little back-and-forth',detail:'Northline included delivery and brought the bundle to $365.',time:'10:33',icon:ArrowDownUp},
  {title:'Ready for your decision',detail:'A matching offer, with $24.05 left in your budget after the fee.',time:'10:34',icon:CheckCheck},
 ]:active?[{title:active.status==='draft'?'Preview draft saved':'Request saved',detail:active.status==='draft'?'This draft has not been sent to businesses.':'Your brief is recorded. Business responses will appear here.',time:dateLabel(active.created_at),icon:FileText},...(offers.length?[{title:`${offers.length} offer${offers.length===1?'':'s'} available`,detail:'Review the current prices and terms before selecting an offer.',time:'Current',icon:CheckCheck}]:[])]:[];
 const filtered=requests.filter(r=>(filter==='All requests'||r.status==='awaiting_payment')&&requestTitle(r).toLowerCase().includes(search.toLowerCase()));
 const hasDemo=preview&&active?.id===demoRequest.id;
 return <div className="app-shell">
  <a className="skip-link" href="#main-content">Skip to workspace</a>
  {mobileNav&&<button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setMobileNav(false)}/>}
  <aside className={`sidebar ${mobileNav?'mobile-open':''}`} aria-label="Main navigation">
   <a className="brand-link" href="/" aria-label="Exchangent home"><Brand/></a>
   <button className="workspace-switch" onClick={()=>setModal('auth')}><span className="workspace-avatar">{user?user.email[0].toUpperCase():'P'}</span><span><strong>Personal workspace</strong><small>{preview?'Explore the preview':'Buyer workspace'}</small></span><ChevronsUpDown size={14}/></button>
   <nav>{([{label:'Overview',icon:LayoutDashboard},{label:'Requests',icon:FileText},{label:'Your agent',icon:Workflow},{label:'Orders',icon:Package}] as const).map(({label,icon:Icon})=><button key={label} className={`nav-item ${view===label?'selected':''}`} onClick={()=>nav(label)} aria-current={view===label?'page':undefined}><Icon size={18} strokeWidth={1.6}/><span>{label}</span>{label==='Requests'&&requests.length>0&&<span className="nav-count">{requests.length}</span>}{label==='Your agent'&&<span className="tiny-dot"/>}</button>)}</nav>
   <div className="sidebar-note"><span className="note-line"/><h4>A little less legwork.</h4><p>Your agent finds the options.<br/>You make the call.</p><button className="text-button" onClick={()=>setModal('help')}>How it works <ArrowUpRight size={14}/></button></div>
   <div className="sidebar-bottom"><button className={`nav-item ${view==='Preferences'?'selected':''}`} onClick={()=>nav('Preferences')}><Settings2 size={18} strokeWidth={1.6}/>Preferences</button><button className="nav-item" onClick={()=>setModal('help')}><HelpCircle size={18} strokeWidth={1.6}/>Help & getting started</button><button className="profile" onClick={()=>preview?setModal('auth'):startTransition(async()=>{await endSession();window.location.assign('/');})}><span className="profile-avatar">{user?user.email[0].toUpperCase():'Y'}</span><span><strong>{user?user.email.split('@')[0]:'Your workspace'}</strong><small>{preview?'Sign in to get started':'Signed in'}</small></span>{pending?<Loader2 size={15} className="spin"/>:user?<LogOut size={15}/>:<ArrowUpRight size={15}/>}</button></div>
  </aside>
  <div className="workspace-main">
   <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={()=>setMobileNav(true)} aria-label="Open navigation"><Menu size={20}/></button><span>Workspace</span><ChevronRight size={13}/><strong>{view}</strong></div><div className="topbar-actions"><button className="search-button" aria-label="Search requests" onClick={()=>setModal('search')}><Search size={17}/><span>Search anything</span><kbd>⌘ K</kbd></button><span className="topbar-divider"/><button className="icon-button notification-button" aria-label="View request updates" onClick={()=>{setView('Your agent');setNotice(preview?'You’re viewing illustrative agent activity.':'Activity reflects the latest recorded workspace state.');}}><Bell size={18}/>{reviewCount>0&&<span/>}</button></div></header>
   <main id="main-content" className="page-content">
    <div className="page-heading"><div><h1>{view==='Overview'?'Your buying desk.':view==='Your agent'?'Working on your behalf.':view==='Preferences'?'Make yourself at home.':view==='Requests'?'Your requests.':'Your orders.'}</h1><p>{view==='Overview'?'A clear brief. Better offers. The final say is yours.':view==='Your agent'?'A clear view of what’s happened, and what needs you.':view==='Requests'?'Everything you’ve asked your agent to find.':view==='Orders'?'From the right offer to your doorstep.':'Your workspace, your boundaries.'}</p></div><button className="button primary" onClick={()=>{setFormError('');setModal('request');}}><Plus size={17}/>New request</button></div>
    {preview&&<div className="preview-banner"><span><span className="tiny-dot"/>Preview workspace <span className="banner-detail">· Illustrative businesses and activity</span></span><button onClick={()=>setModal('auth')}>Make it yours <ArrowRight size={14}/></button></div>}
    {error&&<div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={()=>setModal('auth')}>Sign in</button></div>}
    {(view==='Overview'||view==='Requests')&&<>
     <div className="request-toolbar"><div className="tabs" role="tablist" aria-label="Request filter">{(['All requests','Needs you'] as const).map(label=><button role="tab" aria-selected={filter===label} key={label} className={filter===label?'active':''} onClick={()=>setFilter(label)}>{label}<span>{label==='All requests'?requests.length:reviewCount}</span></button>)}</div><span className="toolbar-caption"><LockKeyhole size={13}/>Your budget stays private</span></div>
     {loading?<div className="skeleton-wrap" aria-label="Loading workspace"><div className="skeleton large"/><div className="skeleton"/><div className="skeleton"/></div>:filtered.length===0?<Empty title={filter==='Needs you'?'Nothing needs your attention.':'Start with what you need.'} action={<button className="button secondary" onClick={()=>setModal('request')}><Plus size={16}/>Create a request</button>}>{filter==='Needs you'?'When an offer is ready for review, you’ll find it here.':'Tell your agent what you’re looking for, your budget, and what matters most.'}</Empty>:<>
      {filtered.length>1&&<div className="request-picker">{filtered.map(r=><button key={r.id} className={selected===r.id?'active':''} onClick={()=>{setSelected(r.id);if(preview)setOffers(r.id===demoRequest.id?demoOffers:[]);}}>{requestTitle(r)}<span>{statusLabel(r.status)}</span></button>)}</div>}
      {active&&<section className="request-summary" aria-labelledby="request-title"><div className="request-summary-copy"><div className="request-status-row"><Status>{statusLabel(active.status)}</Status><span className="request-reference">{preview?'REQUEST 001':`REQ ${active.id.slice(0,8).toUpperCase()}`}</span></div><h2 id="request-title">{requestTitle(active)}</h2><p>{hasDemo?'An oak desk, a comfortable chair, and a fresh start. Both delivered to your door this weekend.':active.requirements.split('\n').slice(1).join(' ')||active.requirements}</p><div className="request-facts">{budgetCents&&<span><span className="fact-label">Budget</span><strong>{money(budgetCents)}</strong><small>all in</small></span>}<span><MapPin size={15}/>{hasDemo?'San Francisco':'Your delivery requirements'}</span>{hasDemo&&<span><Clock3 size={15}/>This weekend</span>}</div><div className="brief-chips">{hasDemo?<><span>Desk ≤ 48″</span><span>Ergonomic chair</span><span>Pre-owned welcome</span></>:<span>{active.status==='draft'?'Not sent to businesses':'Saved to your workspace'}</span>}</div></div><div className="request-objects" aria-hidden="true"><div className="object desk-object"><Table2 size={66} strokeWidth={.9}/><span>THE DESK</span></div><div className="object chair-object"><Armchair size={66} strokeWidth={.9}/><span>THE CHAIR</span></div><div className="object-caption">Room for something better.</div></div></section>}
      <div className="workspace-grid"><section className="offers-section" aria-labelledby="offers-title"><div className="section-heading"><div><h2 id="offers-title">Your offers <span className="number-tag">{offers.length}</span></h2><p>{offers.length?'The details are handled. Here’s what matters.':'Your options will appear here as businesses respond.'}</p></div><button className="sort-control" aria-label={`Sort offers by ${sort==='price'?'price':'recommendation'}`} onClick={()=>setSort(s=>s==='price'?'recommended':'price')}><SlidersHorizontal size={14}/>{sort==='price'?'Price':'Best fit'}<ChevronDown size={13}/></button></div>
       <div className="offer-list">{selectedOffers.length?selectedOffers.map((offer,index)=>{const over=budgetCents!==undefined&&offer.total_cents>budgetCents;return <article className={`offer ${offer.recommended?'recommended':''}`} key={offer.id}><div className="offer-top"><div className={`seller-avatar seller-${index}`}>{offer.name?offer.name.split(' ').map(x=>x[0]).slice(0,2).join(''):index+1}</div><div className="seller-name"><h3>{offer.name??`Business ${offer.seller_id.slice(0,6)}`}</h3><span>{offer.tagline??'Participating seller'}</span></div>{offer.recommended&&<span className="recommendation"><Check size={12}/>Agent’s pick</span>}</div><div className="offer-body"><div><p className="offer-description">{offer.description??`${offer.items.reduce((n,i)=>n+i.quantity,0)} items in this offer`}</p><p className="offer-delivery"><Truck size={14}/>{offer.delivery??'Delivery included in the agreed terms'}</p>{offer.recommended&&<p className="offer-fit"><Check size={13}/>Meets your size, budget, and delivery needs</p>}</div><div className="offer-price"><strong>{money(offer.total_cents)}</strong><span>{preview?'including delivery & fee':'total payable'}</span></div></div>{offer.recommended&&<div className="agent-reason"><AgentMark small/><p>“The right dimensions, a comfortable chair, and delivery on your terms. This is the strongest fit.”</p></div>}<div className="offer-footer"><span>{over?'Above your budget':hasDemo?'Within your budget':'Seller offer'}{hasDemo&&!over&&<span className="budget-room"> · {money(40000-offer.total_cents)} to spare</span>}</span><button className={`button ${offer.recommended?'primary':'secondary'} compact`} onClick={()=>setReview(offer)}>Review offer<ArrowUpRight size={14}/></button></div></article>;}):<Empty title={active?.status==='draft'?'Your brief is a good start.':'Waiting for the first offer.'}>{active?.status==='draft'?'Sign in to send this request and keep track of real offers.':'Your request is saved. You can come back later; this page will show the latest recorded offers.'}</Empty>}</div>
       <div className="approval-note"><ShieldCheck size={17}/><p><strong>Your agent negotiates. You approve.</strong><br/>Nothing is purchased until you review the total and complete checkout.</p></div>
      </section><aside className="activity-panel" aria-label="Agent activity"><div className="activity-heading"><AgentMark/><div><h2>Your agent</h2><span>{hasDemo?'Ready when you are':offers.length?'Offers available':'Standing by'}</span></div><span className="tiny-dot"/></div><div className="activity-intro">{hasDemo?'The legwork, at a glance.':'Updates from your workspace.'}{preview&&<span>Preview activity</span>}</div><ol className="timeline">{events.map((event,index)=>{const Icon=event.icon;return <li key={event.title}><span className={`timeline-icon ${index===events.length-1?'last':''}`}><Icon size={14} strokeWidth={1.6}/></span><div><div className="event-title"><strong>{event.title}</strong><time>{event.time}</time></div><p>{event.detail}</p></div></li>;})}</ol><div className="activity-bottom"><LockKeyhole size={14}/><span>Your agent can negotiate.<br/>Only you can approve payment.</span></div></aside></div>
     </>}
    </>}
    {view==='Your agent'&&<section className="agent-page"><div className="agent-profile"><AgentMark/><div><h2>Your personal buying agent</h2><p>{preview?'Preview workspace · sample activity':'Your workspace connection'}</p></div><Status>{preview?'Preview':'Connected'}</Status></div><div className="agent-boundaries"><div><ShieldCheck size={22}/><h3>You set the boundaries.</h3><p>Your requests define what matters. Your agent can compare options and negotiate within approved limits. Payment always needs your approval.</p></div><div><FileText size={22}/><h3>One shared view.</h3><p>Offers and order status belong to your workspace. When your assistant is connected, you can check the same information in chat or here.</p></div></div><div className="section-heading"><h2>Recorded activity</h2><span className="muted">{preview?'Illustrative example':'Current request'}</span></div><div className="activity-table">{events.length?events.map(e=><div key={e.title}><Check size={16}/><span><strong>{e.title}</strong><small>{e.detail}</small></span><time>{e.time}</time></div>):<Empty title="Your first request starts here." action={<button className="button secondary" onClick={()=>setModal('request')}>New request<Plus size={15}/></button>}>Create a request to give your agent a clear brief.</Empty>}</div></section>}
    {view==='Orders'&&<section className="orders-section">{order?.order?<article className="order-card"><div><Status>Payment confirmed</Status><h2>Your purchase is confirmed.</h2><p>Payment has been verified. Delivery remains subject to the seller’s agreed terms.</p></div><dl><div><dt>Order</dt><dd className="mono">{order.order.id.slice(0,8).toUpperCase()}</dd></div><div><dt>Total paid</dt><dd>{money(order.order.total_cents)}</dd></div><div><dt>Date</dt><dd>{dateLabel(order.order.created_at)}</dd></div></dl></article>:<Empty title="Good finds will land here." action={<button className="button secondary" onClick={()=>nav('Overview')}>Back to your workspace<ArrowRight size={15}/></button>}>After you approve an offer and payment is confirmed, your order will be saved here.</Empty>}</section>}
    {view==='Preferences'&&<section className="preferences"><h2>Your workspace</h2><div className="preference-row"><span><strong>Account</strong><small>{user?.email??'You’re exploring the preview workspace.'}</small></span><button className="button secondary" onClick={()=>setModal('auth')}>{preview?'Sign in':'Manage sign-in'}</button></div><div className="preference-row"><span><strong>Purchase approval</strong><small>You review the final total before every payment.</small></span><span className="preference-value"><LockKeyhole size={14}/>Always required</span></div><div className="preference-row"><span><strong>Payment details</strong><small>Handled securely in hosted Stripe checkout.</small></span><ShieldCheck size={19}/></div><div className="preference-row"><span><strong>Appearance</strong><small>Clear, comfortable, and easy on the eyes.</small></span><span className="preference-value">Light</span></div></section>}
    <footer className="page-footer"><span><Brand small/>A little more considered.</span><span>Built for people. Open to agents.</span></footer>
   </main>
  </div>
  <AnimatePresence>{notice&&<motion.div className="toast" role="status" initial={reduced?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}}><Check size={17}/>{notice}<button className="icon-button" onClick={()=>setNotice('')} aria-label="Dismiss notification"><X size={14}/></button></motion.div>}</AnimatePresence>
  <WorkspaceDialog open={modal==='auth'} onClose={()=>setModal(null)} title="Make room for a better way to buy." description="Sign in to your personal Exchangent workspace."><SignIn onDone={()=>{setModal(null);router.refresh();window.location.assign('/');}}/></WorkspaceDialog>
  <WorkspaceDialog open={modal==='request'} onClose={()=>!busy&&setModal(null)} title="What are you looking for?" description="Give your agent a clear brief. You’ll always have the final say.">
   <form className="stack-form" onSubmit={submitRequest}><label>Name your request<input value={title} onChange={e=>{setTitle(e.target.value);createKey.current=null;}} placeholder="A better home office" maxLength={90} required/></label><label>What matters to you?<textarea value={brief} onChange={e=>{setBrief(e.target.value);createKey.current=null;}} rows={4} placeholder="A desk and ergonomic chair. The desk should fit a 48-inch space. Pre-owned is welcome." maxLength={3500} required/></label><div className="form-grid"><label>Total budget<div className="input-with-prefix"><span>$</span><input type="number" min="1" max="1000000" step=".01" value={budget} onChange={e=>{setBudget(e.target.value);createKey.current=null;}} required/></div><span className="field-help">Including delivery and any fees.</span></label><label>Delivery area<input value={location} onChange={e=>{setLocation(e.target.value);createKey.current=null;}} maxLength={100} required/></label></div><label>When do you need it?<input value={delivery} onChange={e=>{setDelivery(e.target.value);createKey.current=null;}} placeholder="This weekend" maxLength={100} required/></label>{formError&&<p className="form-error" role="alert">{formError}</p>}<div className="form-assurance"><ShieldCheck size={16}/>A request starts a search, not a purchase.</div><button className="button primary full" disabled={busy}>{busy?<Loader2 className="spin" size={17}/>:<ArrowRight size={17}/>} {preview?'Save preview request':'Send request'}</button>{preview&&<p className="fine-print">This saves an illustrative draft only. <button type="button" className="inline-button" onClick={()=>setModal('auth')}>Sign in</button> to send a real request.</p>}</form>
  </WorkspaceDialog>
  <WorkspaceDialog open={review!==null} onClose={()=>!busy&&setReview(null)} title="A good fit. Your call." description={review?.name??'Review the seller’s offer before continuing.'} className="review-dialog">
   {review&&<div className="review-content"><div className="review-bundle"><span><Table2 size={31} strokeWidth={1.2}/><Armchair size={31} strokeWidth={1.2}/></span><div><h3>{review.description??'Your selected bundle'}</h3><p>{review.delivery??'Delivery as agreed in the offer'}</p></div></div><dl className="price-breakdown"><div><dt>Items</dt><dd>{money(review.items.reduce((n,i)=>n+i.quantity*i.unit_cents,0))}</dd></div><div><dt>Delivery</dt><dd>{money(review.delivery_cents)}</dd></div><div><dt>{preview?'Illustrative Exchangent fee (3%)':'Exchangent fee'}</dt><dd>{money(review.fee_cents??0)}</dd></div><div><dt>{preview?'Demo tax':'Tax included in offer'}</dt><dd>{money(review.tax_cents)}</dd></div><div className="total"><dt>Total</dt><dd>{money(review.total_cents)}</dd></div></dl>{budgetCents!==undefined&&<p className="review-budget">{review.total_cents>budgetCents?'This offer is above your budget.':`${money(budgetCents-review.total_cents)} within your ${money(budgetCents)} budget.`}</p>}<div className="review-protection"><ShieldCheck size={18}/><p>{preview?'This is an illustrative offer. Sign in and create your own request to receive real offers.':'Your items will be reserved before Stripe checkout opens. Payment is confirmed only after verification.'}</p></div><button className="button primary full" disabled={busy||(budgetCents!==undefined&&review.total_cents>budgetCents)} onClick={()=>checkout(review)}>{busy?<Loader2 size={17} className="spin"/>:<LockKeyhole size={16}/>} {preview?'Sign in to start your own request':'Reserve & continue to checkout'}<ArrowRight size={16}/></button><p className="fine-print">{preview?'No reservation or payment is made in preview.':'Sandbox checkout · no real money is charged.'}</p></div>}
  </WorkspaceDialog>
  <WorkspaceDialog open={modal==='search'} onClose={()=>{setModal(null);setSearch('');}} title="Find a request" description="Search your workspace by request name."><div className="stack-form"><label className="search-field"><Search size={17}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search requests…" autoFocus/></label><div className="search-results">{requests.filter(r=>requestTitle(r).toLowerCase().includes(search.toLowerCase())).map(r=><button key={r.id} onClick={()=>{setSelected(r.id);if(preview)setOffers(r.id===demoRequest.id?demoOffers:[]);setView('Overview');setSearch('');setModal(null);}}><FileText size={17}/><span>{requestTitle(r)}<small>{statusLabel(r.status)}</small></span><ArrowUpRight size={16}/></button>)}{requests.filter(r=>requestTitle(r).toLowerCase().includes(search.toLowerCase())).length===0&&<p className="fine-print">No matching requests. Try a different name.</p>}</div></div></WorkspaceDialog>
  <WorkspaceDialog open={modal==='help'} onClose={()=>setModal(null)} title="A better way to find your next thing." description="Less searching. A clear decision."><div className="help-steps"><div><FileText size={22}/><span><h3>Tell your agent what matters.</h3><p>Your budget, requirements, and delivery preferences give businesses a clear brief.</p></span></div><div><ArrowDownUp size={22}/><span><h3>Let the offers come to you.</h3><p>Participating businesses propose options. Your agent compares the terms and negotiates within your boundaries.</p></span></div><div><ShieldCheck size={22}/><span><h3>Keep the final say.</h3><p>Review your offer and complete hosted checkout. You’ll see confirmation only after payment is verified.</p></span></div></div><button className="button primary full" onClick={()=>{setModal('request');setFormError('');}}>Create your first request<ArrowRight size={16}/></button></WorkspaceDialog>
 </div>;
}
