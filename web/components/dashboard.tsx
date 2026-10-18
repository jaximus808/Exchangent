'use client';

import {useCallback,useEffect,useState,useTransition} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ArrowRight,Bot,Check,ChevronRight,LayoutDashboard,Loader2,LockKeyhole,LogOut,Menu,Plug,Plus,Radio,ShieldCheck,ShoppingBag,Store,X} from 'lucide-react';
import {endSession} from '@/app/actions';
import {agreedDeal,bestOffer,type Conversation} from '@/lib/conversation';
import {api,errorText,money,type Business,type BuyRequest} from '@/lib/workspace';
import {Buying,RequestCard} from './buying';
import {Selling,CreateBusinessForm} from './selling';
import {Connect} from './connect';
import {SignInForm} from './sign-in';
import {Brand,WorkspaceDialog,initials} from './ui';
import './dashboard.css';

type User={id:string;email:string};
type View='Overview'|'Buying'|'Selling'|'Connect';
const NAV=[{label:'Overview',icon:LayoutDashboard},{label:'Buying',icon:ShoppingBag},{label:'Selling',icon:Store},{label:'Connect',icon:Plug}] as const;
const HEADINGS:Record<View,[string,string]>={
 Overview:['Your workspace.','Your agent buys. Sellers’ agents sell. You approve every payment.'],
 Buying:['What you’re buying.','Every request, every offer and every message your agent traded for it.'],
 Selling:['What you’re selling.','Your businesses, your stock and your private minimums, and how your seller agent is negotiating.'],
 Connect:['Connect your assistant.','Exchangent lives inside Claude. Connect once, then buy or sell in plain language.'],
};
const CONV_LIMIT=12;

function Landing({configured}:{configured:boolean}) {
 return <div className="landing">
  <header className="landing-top"><Brand/><a className="text-button" href="#sign-in">Sign in<ArrowRight size={14}/></a></header>
  <main className="landing-main">
   <section className="landing-copy">
    <span className="landing-kicker"><span className="tiny-dot"/>Live at YC · Make Something Agents Want</span>
    <h1>Your agent buys.<br/>Their agent sells.<br/><span>You approve.</span></h1>
    <p>Tell Claude what you need. Your buying agent haggles with every seller’s agent over Inkbox, within rules Exchangent enforces, and emails you when it has a deal. You pay with Stripe only after you approve.</p>
    <ol className="landing-steps">
     <li><span>1</span><div><strong>Ask in Claude</strong><small>Say what you need, your budget and when you need it by.</small></div></li>
     <li><span>2</span><div><strong>Agents negotiate</strong><small>Buyer and seller agents trade offers. Floors and budgets stay private.</small></div></li>
     <li><span>3</span><div><strong>You approve</strong><small>Reserve the deal and pay in a Stripe test checkout.</small></div></li>
    </ol>
   </section>
   <section className="landing-card" id="sign-in" aria-labelledby="signin-title">
    <h2 id="signin-title">Sign in or create your account</h2>
    <p>Use any email. A new email creates your Exchangent account, for buying, selling or both.</p>
    {configured?<SignInForm/>:<p className="form-error">Sign-in isn’t configured on this server yet.</p>}
    <p className="fine-print"><LockKeyhole size={11}/> No password. Payment details stay with Stripe.</p>
   </section>
  </main>
  <div className="landing-connect"><Connect/></div>
  <footer className="page-footer landing-foot"><span><Brand small/>Built for people. Open to agents.</span><span>Test payments only.</span></footer>
 </div>;
}

export function Dashboard({user,configured}:{user:User|null;configured:boolean}) {
 if(!user) return <Landing configured={configured}/>;
 return <Workspace user={user}/>;
}

function Workspace({user}:{user:User}) {
 const reduced=useReducedMotion();
 const[view,setView]=useState<View>('Overview');const[mobileNav,setMobileNav]=useState(false);
 const[requests,setRequests]=useState<BuyRequest[]>([]);const[convs,setConvs]=useState<Record<string,Conversation|null>>({});
 const[businesses,setBusinesses]=useState<Business[]>([]);const[selected,setSelected]=useState('');
 const[loadingRequests,setLoadingRequests]=useState(true);const[loadingBusinesses,setLoadingBusinesses]=useState(true);
 const[error,setError]=useState('');const[notice,setNotice]=useState('');const[creating,setCreating]=useState(false);
 const[signingOut,startSignOut]=useTransition();
 const nav=(next:View)=>{setView(next);setMobileNav(false);try{history.replaceState(null,'',next==='Overview'?location.pathname:`#${next.toLowerCase()}`);}catch{/* history blocked */}};
 // Deep links: /#buying, /#selling, /#connect.
 useEffect(()=>{const hash=location.hash.slice(1).toLowerCase();const match=NAV.find(n=>n.label.toLowerCase()===hash);if(match)setView(match.label);},[]);
 useEffect(()=>{if(!notice)return;const id=setTimeout(()=>setNotice(''),4500);return()=>clearTimeout(id);},[notice]);

 const loadRequests=useCallback(async()=>{
  if(document.visibilityState==='hidden') return;
  try {
   const rows=await api<BuyRequest[]>('buy-requests');
   setRequests(rows);setError('');
   const pairs=await Promise.all(rows.slice(0,CONV_LIMIT).map(async r=>[r.id,await api<Conversation>(`buy-requests/${r.id}/conversation`).catch(()=>null)] as const));
   setConvs(old=>({...old,...Object.fromEntries(pairs.map(([id,c])=>[id,c??old[id]??null]))}));
  } catch(e){setError(errorText(e,'Your requests couldn’t be loaded.'));}
  finally{setLoadingRequests(false);}
 },[]);
 const loadBusinesses=useCallback(async()=>{
  if(document.visibilityState==='hidden') return;
  try {setBusinesses(await api<Business[]>('businesses'));} catch {/* selling stays empty; buying still works */}
  finally{setLoadingBusinesses(false);}
 },[]);
 const negotiating=requests.some(r=>r.status==='negotiating');
 useEffect(()=>{void loadRequests();const t=setInterval(loadRequests,negotiating?5000:15000);return()=>clearInterval(t);},[loadRequests,negotiating]);
 useEffect(()=>{void loadBusinesses();const t=setInterval(loadBusinesses,20000);return()=>clearInterval(t);},[loadBusinesses]);

 const live=requests.filter(r=>r.status==='negotiating');
 const deals=requests.map(r=>agreedDeal(convs[r.id])).filter(Boolean);
 const bestNow=requests.map(r=>bestOffer(convs[r.id])?.offer.total_cents).filter((n):n is number=>n!==undefined);
 const[title,subtitle]=HEADINGS[view];
 return <div className="app-shell">
  <a className="skip-link" href="#main-content">Skip to workspace</a>
  {mobileNav&&<button className="sidebar-scrim" aria-label="Close navigation" onClick={()=>setMobileNav(false)}/>}
  <aside className={`sidebar ${mobileNav?'mobile-open':''}`} aria-label="Main navigation">
   <a className="brand-link" href="/" aria-label="Exchangent home"><Brand/></a>
   <div className="workspace-switch static"><span className="workspace-avatar">{user.email[0].toUpperCase()}</span><span><strong>{user.email}</strong><small>{businesses.length?`Buyer · ${businesses.length} business${businesses.length===1?'':'es'}`:'Buyer account'}</small></span></div>
   <nav>{NAV.map(({label,icon:Icon})=><button key={label} className={`nav-item ${view===label?'selected':''}`} onClick={()=>nav(label)} aria-current={view===label?'page':undefined}><Icon size={18} strokeWidth={1.6}/><span>{label}</span>{label==='Buying'&&live.length>0&&<span className="nav-count live">{live.length}</span>}{label==='Selling'&&businesses.length>0&&<span className="nav-count">{businesses.length}</span>}</button>)}</nav>
   <div className="sidebar-note"><span className="note-line"/><h4>Agents haggle. You decide.</h4><p>Every price is checked against stock, floors and budgets before it counts.</p></div>
   <div className="sidebar-bottom"><button className="profile" disabled={signingOut} onClick={()=>startSignOut(async()=>{await endSession();window.location.assign('/');})}><span className="profile-avatar">{user.email[0].toUpperCase()}</span><span><strong>{user.email.split('@')[0]}</strong><small>Sign out</small></span>{signingOut?<Loader2 size={15} className="spin"/>:<LogOut size={15}/>}</button></div>
  </aside>
  <div className="workspace-main">
   <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={()=>setMobileNav(true)} aria-label="Open navigation"><Menu size={20}/></button><span>Workspace</span><ChevronRight size={13}/><strong>{view}</strong></div>
    <div className="topbar-actions">{live.length>0&&<a className="live-chip" href={`/watch/${live[0].id}`} target="_blank" rel="noopener"><span className="live-dot"/>{live.length} live negotiation{live.length===1?'':'s'}</a>}<button className="button secondary compact" onClick={()=>setCreating(true)}><Store size={14}/>New business</button></div></header>
   <main id="main-content" className="page-content">
    <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{view==='Selling'&&businesses.length>0&&<button className="button primary" onClick={()=>setCreating(true)}><Plus size={17}/>Create a business</button>}</div>
    {error&&<div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={()=>void loadRequests()}>Retry</button></div>}
    {view==='Overview'&&<div className="overview">
     <dl className="stat-row">
      <div className="stat-tile"><dt><Radio size={14}/>Live negotiations</dt><dd>{live.length}</dd><small>{live.length?'Agents are trading offers now':'Nothing in progress'}</small></div>
      <div className="stat-tile"><dt><Check size={14}/>Deals reached</dt><dd>{deals.length}</dd><small>{deals.length?'Ready for your approval':'Waiting on agents'}</small></div>
      <div className="stat-tile"><dt><ShoppingBag size={14}/>Best offer</dt><dd>{bestNow.length?money(Math.min(...bestNow)):'—'}</dd><small>across your open requests</small></div>
      <div className="stat-tile"><dt><Store size={14}/>Businesses</dt><dd>{businesses.length}</dd><small>{businesses.filter(b=>b.delegate_negotiation).length} with a seller agent</small></div>
     </dl>
     <div className="overview-grid">
      <section><div className="section-heading"><h2>Recent requests</h2><button className="text-button" onClick={()=>nav('Buying')}>All requests<ArrowRight size={13}/></button></div>
       {loadingRequests?<div className="skeleton"/>:requests.length?<div className="request-list">{requests.slice(0,3).map(r=><RequestCard key={r.id} request={r} conv={convs[r.id]} onSelect={()=>{setSelected(r.id);nav('Buying');}}/>)}</div>:<div className="hint-card"><Bot size={18}/><p>No requests yet. Ask Claude: <em>“Find me a desk under 48 inches and an ergonomic chair, $400 all-in.”</em></p><button className="text-button" onClick={()=>nav('Connect')}>Connect Claude<ArrowRight size={13}/></button></div>}
      </section>
      <section><div className="section-heading"><h2>Your businesses</h2><button className="text-button" onClick={()=>nav('Selling')}>Manage<ArrowRight size={13}/></button></div>
       {loadingBusinesses?<div className="skeleton"/>:businesses.length?<div className="business-mini-list">{businesses.map(b=><button key={b.seller_id} className="business-mini" onClick={()=>nav('Selling')}><span className="seller-badge" aria-hidden="true">{initials(b.name)}</span><span><strong>{b.name}</strong><small>{b.delegate_negotiation?'Seller agent negotiating':'You negotiate in chat'}{b.agent_handle?` · @${b.agent_handle}`:''}</small></span><ChevronRight size={15}/></button>)}</div>:<div className="hint-card"><Store size={18}/><p>Sell too. Create a business, add stock with private minimums, and a seller agent haggles for you.</p><button className="text-button" onClick={()=>setCreating(true)}>Create a business<ArrowRight size={13}/></button></div>}
       <div className="assurance"><ShieldCheck size={16}/><p><strong>Rules live in one place.</strong> Agents only act through Exchangent, which checks every offer against stock, your floors and the buyer’s budget.</p></div>
      </section>
     </div>
     <Connect compact/>
    </div>}
    {view==='Buying'&&<Buying userId={user.id} requests={requests} convs={convs} loading={loadingRequests} selected={selected} onSelect={setSelected} onChanged={()=>void loadRequests()}/>}
    {view==='Selling'&&<Selling businesses={businesses} loading={loadingBusinesses} onCreate={()=>setCreating(true)} onChanged={b=>setBusinesses(list=>list.map(x=>x.seller_id===b.seller_id?{...x,...b}:x))}/>}
    {view==='Connect'&&<Connect/>}
    <footer className="page-footer"><span><Brand small/>Built for people. Open to agents.</span><span>Test payments only · no real money moves.</span></footer>
   </main>
  </div>
  <AnimatePresence>{notice&&<motion.div className="toast" role="status" initial={reduced?false:{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0}}><Check size={17}/>{notice}<button className="icon-button" onClick={()=>setNotice('')} aria-label="Dismiss notification"><X size={14}/></button></motion.div>}</AnimatePresence>
  <WorkspaceDialog open={creating} onClose={()=>setCreating(false)} title="Create a business" description="Sell on Exchangent with this email. You can connect it in Claude as a seller right after.">
   <CreateBusinessForm onCreated={b=>{setBusinesses(list=>[...list.filter(x=>x.seller_id!==b.seller_id),b]);setCreating(false);setView('Selling');setNotice(`${b.name} is ready. Add stock to start selling.`);}}/>
  </WorkspaceDialog>
 </div>;
}
