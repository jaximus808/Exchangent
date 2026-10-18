'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {AlertTriangle,Check,CheckCircle2,Loader2,PackageCheck,Scale,ShieldCheck,Truck,Undo2} from 'lucide-react';
import {api,ApiError,caseIdOf,dollarsToCents,errorText,itemIdOf,listOf,money,orderIdOf,type Business,type Case,type CaseMove,type Order,type Policy,type Remedy} from '@/lib/workspace';
import {Status,WorkspaceDialog} from './ui';
import './thread.css';
import './orders.css';

type Viewer='buyer'|'seller';
const CASE_TYPES:[string,string][]=[['not_received','It never arrived'],['damaged','It arrived damaged'],['not_as_described','Not as described'],['missing_item','An item is missing'],['wrong_item','Wrong item'],['late','It arrived late'],['changed_mind','I changed my mind'],['duplicate_charge','I was charged twice']];
const TYPE_LABEL:Record<string,string>={...Object.fromEntries(CASE_TYPES),substitution:'Out of stock · substitute offered'};
const caseTypeLabel=(t?:string)=>TYPE_LABEL[t??'']??(t??'Problem').replaceAll('_',' ');
const ACTION:Record<string,string>={open:'opened',offer:'proposed',accept:'accepted',decline:'declined',auto:'settled automatically',escalate:'escalated'};
const HOW:Record<string,string>={auto:'Settled automatically from verified facts',policy:'Accepted under the seller’s policy',agreed:'Agreed by both sides'};
const stamp=(d?:string|null)=>d?new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
const caseStatus=(c:Case)=>c.status??'open';
const movesOf=(c:Case):CaseMove[]=>c.moves??c.history??[];

export function remedyLabel(r?:Remedy|null) {
 if(!r) return 'No remedy proposed';
 const amount=r.amount_cents!==undefined?money(r.amount_cents):'';
 switch(r.kind) {
  case 'refund_full':return 'Full refund';
  case 'refund_partial':return amount?`${amount} back, keep the goods`:'Partial refund';
  case 'refund_items':return `Refund the affected item${r.items&&r.items.length!==1?'s':''}${amount?` (${amount})`:''}`;
  case 'replace':return 'Ship a replacement';
  case 'return_for_refund':return `Return for a refund${r.return_shipping_paid_by?` · ${r.return_shipping_paid_by} pays return shipping`:''}`;
  case 'keep_with_discount':return amount?`Keep it with ${amount} back`:'Keep it with a discount';
  case 'sla_credit':return amount?`${amount} delivery credit`:'Delivery-fee credit';
  case 'cancel':return 'Cancel before shipping';
  default:return r.kind.replaceAll('_',' ');
 }
}

function Timeline({order}:{order:Order}) {
 const s=order.status??'confirmed',src=order.delivery_evidence?.source;
 const steps=[
  {label:'Paid',at:order.created_at,done:true},
  {label:'Shipped',at:order.shipped_at,done:!!order.shipped_at||['shipped','delivered','closed'].includes(s),detail:order.carrier?`${order.carrier}${order.tracking?` · ${order.tracking}`:''}`:''},
  {label:'Delivered',at:order.delivered_at,done:!!order.delivered_at||['delivered','closed'].includes(s),detail:src==='simulated'?'Simulated scan · test mode':src==='buyer_confirmed'?'Confirmed by buyer':src==='carrier'?'Carrier scan':''},
  {label:s==='refunded'?'Refunded':s==='cancelled'?'Cancelled':'Closed',at:null,done:['closed','refunded','cancelled'].includes(s)},
 ];
 return <ol className="order-steps" aria-label="Order progress">{steps.map(step=><li key={step.label} className={step.done?'done':''}><span className="order-step-dot" aria-hidden="true">{step.done?<Check size={11}/>:null}</span><div><strong>{step.label}</strong>{step.at&&<time>{stamp(step.at)}</time>}{step.detail&&<small>{step.detail}</small>}</div></li>)}</ol>;
}

/** Accept / counter / decline on a case when it's this viewer's turn. */
function RespondBar({c,path,onDone}:{c:Case;path:string;onDone:()=>void}) {
 const[counter,setCounter]=useState(false);const[kind,setKind]=useState('keep_with_discount');const[amount,setAmount]=useState('');const[note,setNote]=useState('');
 const[busy,setBusy]=useState<string|null>(null);const[error,setError]=useState('');const key=useRef<Record<string,string>>({});
 async function send(action:'accept'|'decline'|'counter') {
  setBusy(action);setError('');
  let remedy:Remedy|undefined;
  if(action==='counter') {
   remedy={kind};
   if(['refund_partial','keep_with_discount'].includes(kind)) {const cents=dollarsToCents(amount);if(!Number.isInteger(cents)||cents<=0){setBusy(null);return setError('Enter the amount back.');}remedy.amount_cents=cents;}
   if(kind==='return_for_refund') remedy.return_shipping_paid_by='seller';
  }
  try {
   key.current[action]??=crypto.randomUUID();
   await api(path,{method:'POST',headers:{'idempotency-key':key.current[action]},body:JSON.stringify({expected_version:c.version??0,action,...(remedy?{remedy}:{}),...(note.trim()?{note:note.trim()}:{})})});
   setCounter(false);onDone();
  } catch(e){setError(errorText(e,'That response couldn’t be sent.'));} finally{setBusy(null);}
 }
 return <div className="respond-bar">
  {!counter?<div className="respond-actions">
   <button className="button primary compact" disabled={busy!==null} onClick={()=>void send('accept')}>{busy==='accept'?<Loader2 size={14} className="spin"/>:<Check size={14}/>}Accept</button>
   <button className="button secondary compact" disabled={busy!==null} onClick={()=>setCounter(true)}><Scale size={14}/>Counter</button>
   <button className="text-button" disabled={busy!==null} onClick={()=>void send('decline')}>{busy==='decline'?<Loader2 size={13} className="spin"/>:null}Decline</button>
  </div>:<form className="stack-form counter-form" onSubmit={e=>{e.preventDefault();void send('counter');}}>
   <div className="form-grid"><label>Remedy<select value={kind} onChange={e=>setKind(e.target.value)}>
    <option value="keep_with_discount">Keep it with money back</option><option value="refund_partial">Partial refund</option><option value="refund_items">Refund the affected items</option>
    <option value="replace">Ship a replacement</option><option value="return_for_refund">Return for a refund</option><option value="refund_full">Full refund</option></select></label>
    {['refund_partial','keep_with_discount'].includes(kind)&&<label>Amount back<div className="input-with-prefix"><span>$</span><input type="number" min="0.01" step=".01" value={amount} onChange={e=>setAmount(e.target.value)} required/></div></label>}</div>
   <label>Note (optional)<input value={note} onChange={e=>setNote(e.target.value)} maxLength={500} placeholder="Happy to meet in the middle."/></label>
   <div className="respond-actions"><button className="button primary compact" disabled={busy!==null}>{busy==='counter'?<Loader2 size={14} className="spin"/>:null}Send counter</button><button type="button" className="text-button" onClick={()=>setCounter(false)}>Cancel</button></div>
  </form>}
  {error&&<p className="form-error" role="alert">{error}</p>}
 </div>;
}

export function CaseCard({c,viewer,respondPath,onChanged,extra}:{c:Case;viewer:Viewer;respondPath?:string;onChanged:()=>void;extra?:React.ReactNode}) {
 const status=caseStatus(c);
 return <article className={`case-card ${status}`}>
  <header className="case-head"><div><strong>{caseTypeLabel(c.type)}</strong><span>{c.title?`${c.title} · `:''}{status==='open'?(c.turn===viewer?'Your turn':`Waiting for the ${c.turn??'other side'}`):status}</span></div><Status tone={status==='open'?'live':status==='resolved'?'done':'muted'}>{status}</Status></header>
  {c.description&&<p className="case-desc">“{c.description}”</p>}
  {c.substitute_check&&<p className={`case-note ${c.substitute_check.meets_requirements?'ok':'warn'}`}>{c.substitute_check.meets_requirements?<CheckCircle2 size={14}/>:<AlertTriangle size={14}/>}{c.substitute_check.meets_requirements?'The substitute meets the original requirements':'The substitute does not meet the original requirements'}{c.substitute_check.unit_cents_delta!==undefined?` · ${c.substitute_check.unit_cents_delta<=0?`${money(Math.abs(c.substitute_check.unit_cents_delta))} cheaper per unit`:`${money(c.substitute_check.unit_cents_delta)} more per unit`}`:''}</p>}
  <div className="thread case-thread">{movesOf(c).map((m,i)=>m.by==='platform'||m.action==='auto'||m.action==='escalate'
   ?<div className="thread-system" key={i}><ShieldCheck size={12}/><span>Exchangent {ACTION[m.action??'']??'updated'}{m.remedy?`: ${remedyLabel(m.remedy)}`:''}</span><time>{stamp(m.created_at??m.at)}</time></div>
   :<div className={`bubble-row ${m.by===viewer?'own':'other'}`} key={i}><div className="bubble"><div className="bubble-head"><strong>{m.by===viewer?'You':m.by==='buyer'?'Buyer':'Seller'}</strong><span>{ACTION[m.action??'']??m.action}</span><time>{stamp(m.created_at??m.at)}</time></div>{m.remedy&&<div className="bubble-price small">{remedyLabel(m.remedy)}</div>}{m.note&&<p className="bubble-note">“{m.note}”</p>}</div></div>)}</div>
  {!!c.evidence?.length&&<ul className="case-evidence">{c.evidence.map((e,i)=><li key={i}><span>{e.kind??'evidence'}</span>{e.ref&&/^https:\/\//.test(e.ref)?<a href={e.ref} target="_blank" rel="noopener noreferrer">{e.ref}</a>:<span>{e.ref}</span>}</li>)}</ul>}
  {status==='resolved'&&c.resolution&&<p className="case-note ok"><CheckCircle2 size={14}/><span><strong>{remedyLabel(c.resolution)}</strong> · {HOW[c.resolution.how??'']??'Resolved'}</span></p>}
  {status==='escalated'&&<p className="case-note warn"><AlertTriangle size={14}/>The two sides’ policies don’t overlap, so this needs a person.</p>}
  {!!c.refunds?.length&&<p className="case-refunds">{c.refunds.map((r,i)=><span key={i}>{r.amount_cents!==undefined?money(r.amount_cents):'Refund'} · {r.status??'pending'}</span>)}</p>}
  {status==='open'&&c.turn===viewer&&respondPath&&<RespondBar c={c} path={respondPath} onDone={onChanged}/>}
  {extra}
 </article>;
}

function ReportProblemForm({order,onDone}:{order:Order;onDone:()=>void}) {
 const[type,setType]=useState('damaged');const[description,setDescription]=useState('');const[photo,setPhoto]=useState('');
 const[picked,setPicked]=useState<Record<string,boolean>>({});const[ask,setAsk]=useState('none');const[amount,setAmount]=useState('');
 const[error,setError]=useState('');const[busy,setBusy]=useState(false);const key=useRef(crypto.randomUUID());
 const items=order.items??[];
 return <form className="stack-form" onSubmit={async e=>{e.preventDefault();setError('');
  if(!description.trim()) return setError('Describe what happened.');
  if(photo.trim()&&!/^https:\/\//.test(photo.trim())) return setError('Photo links must start with https://');
  // Send the item's own ID field back exactly as the order returned it.
  const chosen=items.filter(i=>picked[itemIdOf(i)]).map(i=>i.reservation_item_id!==undefined?{reservation_item_id:i.reservation_item_id,quantity:i.quantity??1}:{id:i.id,quantity:i.quantity??1});
  let requested_remedy:Remedy|undefined;
  if(ask==='keep_with_discount'){const cents=dollarsToCents(amount);if(!Number.isInteger(cents)||cents<=0)return setError('Enter how much you’d like back.');requested_remedy={kind:ask,amount_cents:cents};}
  else if(ask!=='none') requested_remedy={kind:ask,...(ask==='refund_items'&&chosen.length?{items:chosen}:{})};
  setBusy(true);
  try {
   await api(`orders/${orderIdOf(order)}/cases`,{method:'POST',headers:{'idempotency-key':key.current},body:JSON.stringify({type,description:description.trim(),
    ...(chosen.length?{items:chosen}:{}),...(photo.trim()?{evidence:[{kind:'photo',ref:photo.trim()}]}:{}),...(requested_remedy?{requested_remedy}:{})})});
   onDone();
  } catch(err){setError(err instanceof ApiError&&err.status===404?'Problem reports aren’t enabled on this server yet. Ask Claude: “report a problem with my order”.':errorText(err,'The problem couldn’t be reported.'));}
  finally{setBusy(false);}
 }}>
  <label>What went wrong?<select value={type} onChange={e=>setType(e.target.value)}>{CASE_TYPES.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
  {items.length>1&&<fieldset className="item-picks"><legend>Which items? (leave empty for the whole order)</legend>{items.map(i=><label key={itemIdOf(i)} className="check-label"><input type="checkbox" checked={!!picked[itemIdOf(i)]} onChange={e=>setPicked(p=>({...p,[itemIdOf(i)]:e.target.checked}))}/>{i.quantity??1} × {i.title??'Item'}</label>)}</fieldset>}
  <label>Describe it<textarea value={description} onChange={e=>setDescription(e.target.value)} maxLength={1000} rows={3} placeholder="A deep scratch across the desktop." required/></label>
  <label>Photo link (optional)<input value={photo} onChange={e=>setPhoto(e.target.value)} placeholder="https://…" inputMode="url"/></label>
  <div className="form-grid"><label>What would make it right?<select value={ask} onChange={e=>setAsk(e.target.value)}><option value="none">Let the seller propose</option><option value="keep_with_discount">Keep it with money back</option><option value="refund_items">Refund the affected items</option><option value="replace">Send a replacement</option><option value="return_for_refund">Return it for a refund</option><option value="refund_full">Full refund</option></select></label>
   {ask==='keep_with_discount'&&<label>Amount back<div className="input-with-prefix"><span>$</span><input type="number" min="0.01" step=".01" value={amount} onChange={e=>setAmount(e.target.value)} required/></div></label>}</div>
  <p className="field-help"><ShieldCheck size={11}/> Facts Exchangent can verify settle automatically. Otherwise the seller (or their agent) responds within their policy, and every refund is capped at what you paid.</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<AlertTriangle size={15}/>}Report the problem</button>
 </form>;
}

function useList<T>(path:string,key:string,every=8000) {
 const[rows,setRows]=useState<T[]|null|undefined>(undefined);
 const load=useCallback(async()=>{
  if(document.visibilityState==='hidden') return;
  try {setRows(listOf<T>(await api<unknown>(path),key));}
  catch(e){setRows(r=>e instanceof ApiError&&e.status===404?null:r??[]);}
 },[path,key]);
 useEffect(()=>{void load();const t=setInterval(load,every);return()=>clearInterval(t);},[load,every]);
 return [rows,load] as const;
}

/** Buyer: paid orders with their delivery timeline, problem cases and refunds. Hidden on a backend without orders. */
export function BuyerOrders() {
 const[orders,reload]=useList<Order>('orders','orders');
 const[details,setDetails]=useState<Record<string,Order>>({});
 const[reporting,setReporting]=useState<Order|null>(null);const[busy,setBusy]=useState('');const[error,setError]=useState('');
 const loadDetail=useCallback(async(id:string)=>{try{const d=await api<Order>(`orders/${id}`);setDetails(x=>({...x,[id]:d}));}catch{/* the list row still shows */}},[]);
 const refresh=()=>{void reload();for(const id of Object.keys(details)) void loadDetail(id);};
 if(!orders) return null;
 return <section className="detail-section orders-section" aria-labelledby="orders-title">
  <div className="section-heading"><h2 id="orders-title"><PackageCheck size={16}/>Your orders <span className="number-tag">{orders.length}</span></h2><span className="toolbar-caption"><ShieldCheck size={13}/>Problems settle by policy, often without anyone stepping in</span></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {orders.length===0?<p className="muted small-copy">Paid orders show up here with delivery tracking and a way to report problems.</p>:<div className="order-list">{orders.map(o=>{
   const id=orderIdOf(o),d={...o,...details[id]},cases=d.cases??[];
   return <details className="order-card" key={id} onToggle={e=>{if((e.target as HTMLDetailsElement).open&&!details[id])void loadDetail(id);}}>
    <summary><div><strong>{d.title??'Order'}</strong><span>{d.seller_name?`${d.seller_name} · `:''}{d.total_cents!==undefined?money(d.total_cents):''}{d.refunded_cents?` · ${money(d.refunded_cents)} refunded`:''}</span></div><Status tone={['confirmed','shipped'].includes(d.status??'')?'live':d.status==='delivered'||d.status==='closed'?'done':'muted'}>{(d.status??'confirmed').replaceAll('_',' ')}</Status></summary>
    <div className="order-body">
     <Timeline order={d}/>
     {!!d.items?.length&&<dl className="price-breakdown">{d.items.map((i,n)=><div key={n}><dt>{i.quantity??1}× {i.title??'Item'}</dt><dd>{i.unit_cents!==undefined?money((i.quantity??1)*i.unit_cents):''}</dd></div>)}</dl>}
     <div className="respond-actions">
      {d.status==='shipped'&&<button className="button secondary compact" disabled={busy!==''} onClick={async()=>{setBusy(id);setError('');try{await api(`orders/${id}/received`,{method:'POST',headers:{'idempotency-key':`received-${id}`},body:'{}'});refresh();}catch(e){setError(errorText(e));}finally{setBusy('');}}}>{busy===id?<Loader2 size={14} className="spin"/>:<CheckCircle2 size={14}/>}It arrived</button>}
      {!['cancelled','refunded'].includes(d.status??'')&&<button className="button secondary compact" onClick={()=>setReporting(d)}><AlertTriangle size={14}/>Report a problem</button>}
     </div>
     {cases.map(c=><CaseCard key={caseIdOf(c)} c={c} viewer="buyer" respondPath={`cases/${caseIdOf(c)}/respond`} onChanged={refresh}/>)}
    </div>
   </details>;})}</div>}
  <WorkspaceDialog open={!!reporting} onClose={()=>setReporting(null)} title="Report a problem" description="Tell the seller what went wrong. Verifiable facts are settled automatically; otherwise their agent responds within the seller’s policy.">
   {reporting&&<ReportProblemForm order={reporting} onDone={()=>{const id=orderIdOf(reporting);setReporting(null);void reload();void loadDetail(id);}}/>}
  </WorkspaceDialog>
 </section>;
}

function ShipForm({path,onDone}:{path:string;onDone:()=>void}) {
 const[carrier,setCarrier]=useState('');const[tracking,setTracking]=useState('');const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 return <form className="stack-form" onSubmit={async e=>{e.preventDefault();setError('');setBusy(true);
  try{await api(path,{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:JSON.stringify({carrier:carrier.trim(),tracking:tracking.trim()})});onDone();}
  catch(err){setError(errorText(err,'Couldn’t mark it shipped.'));}finally{setBusy(false);}
 }}>
  <div className="form-grid"><label>Carrier<input value={carrier} onChange={e=>setCarrier(e.target.value)} placeholder="UPS" maxLength={100} required autoFocus/></label><label>Tracking<input value={tracking} onChange={e=>setTracking(e.target.value)} placeholder="1Z999…" maxLength={200} required/></label></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Truck size={15}/>}Mark shipped</button>
 </form>;
}

/** Seller: orders to fulfil and problem cases for one business. Hidden on a backend without orders. */
export function SellerOrders({business}:{business:Business}) {
 const base=`businesses/${business.seller_id}`;
 const[orders,reloadOrders]=useList<Order>(`${base}/orders`,'orders');
 const[cases,reloadCases]=useList<Case>(`${base}/cases`,'cases');
 const[shipping,setShipping]=useState<Order|null>(null);const[busy,setBusy]=useState('');const[error,setError]=useState('');
 const refresh=()=>{void reloadOrders();void reloadCases();};
 if(orders===null&&cases===null) return null;
 const toShip=(orders??[]).filter(o=>(o.status??'confirmed')==='confirmed');
 const inTransit=(orders??[]).filter(o=>o.status==='shipped');
 async function post(path:string,id:string) {setBusy(id);setError('');try{await api(path,{method:'POST',headers:{'idempotency-key':crypto.randomUUID()},body:'{}'});refresh();}catch(e){setError(errorText(e));}finally{setBusy('');}}
 return <section className="fulfilment-section">
  <div className="section-heading"><h2><PackageCheck size={16}/>Orders & problems <span className="number-tag">{(orders??[]).length}</span></h2>{!!(cases??[]).filter(c=>caseStatus(c)==='open').length&&<Status tone="live">{(cases??[]).filter(c=>caseStatus(c)==='open').length} open case{(cases??[]).filter(c=>caseStatus(c)==='open').length===1?'':'s'}</Status>}</div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  {orders===undefined?<div className="skeleton"/>:!orders?.length?<p className="muted small-copy">Paid orders appear here to ship. Problems buyers report show up below, and your agent answers them within your policy.</p>:<div className="offer-rows">
   {[...toShip,...inTransit].map(o=>{const id=orderIdOf(o);return <div className="offer-row" key={id}><div className="offer-row-name"><strong>{o.title??'Order'}</strong><span>{o.total_cents!==undefined?money(o.total_cents):''}{o.shipping_name?` · ${o.shipping_name}`:''}{o.carrier?` · ${o.carrier} ${o.tracking??''}`:''}</span></div><Status tone={o.status==='shipped'?'live':'neutral'}>{o.status==='shipped'?'In transit':'To ship'}</Status>
    {o.status==='shipped'?<button className="button secondary compact" disabled={busy!==''} title="Test mode only: records a simulated carrier scan" onClick={()=>void post(`${base}/orders/${id}/simulate-delivery`,id)}>{busy===id?<Loader2 size={14} className="spin"/>:<Truck size={14}/>}Simulate delivery</button>
     :<button className="button primary compact" onClick={()=>setShipping(o)}><Truck size={14}/>Mark shipped</button>}</div>;})}
   {!toShip.length&&!inTransit.length&&<p className="muted small-copy">Nothing to ship right now.</p>}
  </div>}
  {!!cases?.length&&<div className="case-list">{cases.map(c=>{const id=caseIdOf(c);return <CaseCard key={id} c={c} viewer="seller" respondPath={`${base}/cases/${id}/respond`} onChanged={refresh}
   extra={caseStatus(c)==='resolved'&&c.resolution?.kind==='return_for_refund'&&!c.refunds?.some(r=>r.status==='succeeded')?<button className="button secondary compact" disabled={busy!==''} onClick={()=>void post(`${base}/cases/${id}/return-received`,id)}>{busy===id?<Loader2 size={14} className="spin"/>:<Undo2 size={14}/>}Return received · issue refund</button>:null}/>;})}</div>}
  <WorkspaceDialog open={!!shipping} onClose={()=>setShipping(null)} title="Mark shipped" description="The buyer is notified with the carrier and tracking reference.">
   {shipping&&<ShipForm path={`${base}/orders/${orderIdOf(shipping)}/ship`} onDone={()=>{setShipping(null);refresh();}}/>}
  </WorkspaceDialog>
 </section>;
}

const POLICY_FIELDS:[keyof Policy,string,string][]=[
 ['auto_refund_not_received_after_days','Auto-refund if nothing is delivered after','days past the delivery deadline'],
 ['max_auto_partial_refund_pct','Grant partial refunds without asking up to','% of the order'],
 ['return_window_days','Change-of-mind returns for','days after delivery'],
 ['restocking_fee_pct','Restocking fee on change-of-mind returns','%'],
 ['price_protection_days','Refund the difference if you sell it cheaper within','days (0 = off)'],
];

/** Seller: the rules that settle problems automatically for one business. */
export function PolicyEditor({business,onSaved}:{business:Business;onSaved:()=>void}) {
 const path=`businesses/${business.seller_id}/policy`;
 const[policy,setPolicy]=useState<Policy|null|undefined>(undefined);const[draft,setDraft]=useState<Record<string,string>>({});
 const[atFault,setAtFault]=useState(true);const[fight,setFight]=useState('50');const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 useEffect(()=>{api<Policy>(path).then(p=>{setPolicy(p);setDraft(Object.fromEntries(POLICY_FIELDS.map(([k])=>[k,String(p[k]??'')])));setAtFault(p.seller_pays_return_shipping_when_at_fault??true);setFight(p.fight_chargebacks_above_cents!==undefined?String(p.fight_chargebacks_above_cents/100):'50');})
  .catch(e=>setPolicy(e instanceof ApiError&&e.status===404?null:{}));},[path]);
 if(policy===undefined) return <div className="skeleton"/>;
 if(policy===null) return <p className="muted small-copy">Resolution policies aren’t enabled on this server yet. Ask Claude: “show my resolution policy”.</p>;
 return <form className="stack-form" onSubmit={async e=>{e.preventDefault();setError('');
  const body:Record<string,unknown>={seller_pays_return_shipping_when_at_fault:atFault};
  for(const [k] of POLICY_FIELDS){const v=draft[k];if(v===undefined||v==='')continue;const n=Number(v);if(!Number.isInteger(n)||n<0)return setError('Use whole numbers of 0 or more.');body[k]=n;}
  const fc=dollarsToCents(fight||'0');if(!Number.isInteger(fc)||fc<0)return setError('Enter a chargeback amount of $0 or more.');body.fight_chargebacks_above_cents=fc;
  setBusy(true);try{await api(path,{method:'PUT',body:JSON.stringify(body)});onSaved();}catch(err){setError(errorText(err,'The policy couldn’t be saved.'));}finally{setBusy(false);}
 }}>
  {POLICY_FIELDS.map(([k,label,unit])=><label key={k} className="policy-row"><span>{label}</span><span className="policy-input"><input type="number" min="0" step="1" value={draft[k]??''} onChange={e=>setDraft(d=>({...d,[k]:e.target.value}))}/><small>{unit}</small></span></label>)}
  <label className="policy-row"><span>Contest bank chargebacks above</span><span className="policy-input"><div className="input-with-prefix"><span>$</span><input type="number" min="0" step="1" value={fight} onChange={e=>setFight(e.target.value)}/></div></span></label>
  <label className="check-label"><input type="checkbox" checked={atFault} onChange={e=>setAtFault(e.target.checked)}/>I pay return shipping when the problem was mine</label>
  <p className="field-help"><ShieldCheck size={11}/> Your agent negotiates problems inside these limits. Exchangent caps every refund at what the buyer paid.</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Scale size={15}/>}Save policy</button>
 </form>;
}
