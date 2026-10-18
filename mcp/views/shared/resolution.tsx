import {useEffect,useRef,useState} from 'react';
import {useCallTool,useHostContext,useToolContext} from 'mcp-use/react';
import {money} from './data.js';
import {caseId,caseStatus,caseTypeLabel,movesOf,readResolution,remedyLabel,resolvedHow,timeline,type Case,type Move,type Resolution} from './resolution-data.js';
import {readableError} from './presentation.js';
import './style.css';

const clock=(at?:string|null)=>{if(!at)return '';const t=new Date(at);return Number.isNaN(t.getTime())?'':t.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});};
const who=(by?:string)=>by==='buyer'?'Buyer':by==='seller'?'Seller':'Exchangent';
const ACTIONS:Record<string,string>={open:'Opened',offer:'Proposed',accept:'Accepted',decline:'Declined',auto:'Settled automatically',escalate:'Escalated to a person'};

function MoveBubble({m,mine}:{m:Move;mine:boolean}) {
 if(m.by==='platform'||m.action==='auto'||m.action==='escalate')return <li className="chat-system">{ACTIONS[m.action??'']??'Update'}{m.remedy?`: ${remedyLabel(m.remedy)}`:''}{m.note?` · ${m.note}`:''} <time>{clock(m.created_at??m.at)}</time></li>;
 return <li className={`chat-bubble ${mine?'mine':'theirs'}`}>
  <div className="chat-meta"><strong>{who(m.by)}</strong><span>{ACTIONS[m.action??'']??m.action??''}</span><time>{clock(m.created_at??m.at)}</time></div>
  {m.remedy&&<span className="chat-price">{remedyLabel(m.remedy)}</span>}
  {m.note&&<p>{m.note}</p>}
 </li>;
}

function CaseThread({c,viewer}:{c:Case;viewer:'buyer'|'seller'}) {
 const status=caseStatus(c);
 return <article className="thread">
  <div className="thread-head"><h2>{caseTypeLabel(c.type)}</h2><span>{status==='open'?`round ${c.rounds??0} · ${c.turn===viewer?'your turn':`${c.turn??'other side'}’s turn`}`:status??''}</span></div>
  {c.description&&<p className="case-description">{c.description}</p>}
  {c.substitute_check&&<div className={`case-check ${c.substitute_check.meets_requirements?'ok':'warn'}`}><strong>{c.substitute_check.meets_requirements?'Substitute meets the original requirements':'Substitute does not meet the original requirements'}</strong><span>{c.substitute_check.unit_cents_delta===undefined?'':c.substitute_check.unit_cents_delta<=0?`Costs the same or less (${money(Math.abs(c.substitute_check.unit_cents_delta))} difference refunded)`:`Costs ${money(c.substitute_check.unit_cents_delta)} more per unit`}</span></div>}
  <ol className="chat">{movesOf(c).map((m,i)=><MoveBubble key={i} m={m} mine={m.by===viewer}/>)}</ol>
  {!!c.evidence?.length&&<ul className="case-evidence">{c.evidence.map((e,i)=><li key={i}><span>{e.kind??'evidence'}</span>{e.ref&&/^https:\/\//.test(e.ref)?<a href={e.ref} target="_blank" rel="noopener noreferrer">{e.ref}</a>:<span>{e.ref}</span>}</li>)}</ul>}
  {status==='resolved'&&c.resolution&&<div className="case-check ok"><strong>{remedyLabel(c.resolution)}</strong><span>{resolvedHow(c.resolution.how)}</span></div>}
  {status==='escalated'&&<div className="case-check warn"><strong>Needs a person</strong><span>The two sides’ policies don’t overlap, so this case was escalated.</span></div>}
 </article>;
}

export function ResolutionPanel({mode}:{mode:'order'|'case'}) {
 const context=useToolContext<'get_order'>(),host=useHostContext();
 const getOrder=useCallTool('get_order'),getCase=useCallTool('get_case');
 const [current,setCurrent]=useState<Resolution|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const parsed=context.status==='ready'?(()=>{try{return readResolution(context.toolOutput);}catch{return null;}})():null;
 const data=current??parsed;
 const input=context.toolInput as {order_id?:string;case_id?:string}|undefined;
 const orderId=data?.order_id??(typeof data?.id==='string'&&mode==='order'?data.id:undefined)??input?.order_id;
 const thisCaseId=data?(mode==='case'?caseId(data):undefined)??input?.case_id:input?.case_id;
 const viewer:'buyer'|'seller'=data?.viewer==='seller'||data?.role==='seller'?'seller':'buyer';
 const canCall=host.isAvailable&&!!host.hostCapabilities?.serverTools;
 const cases=mode==='case'&&data?[data as Case]:(data?.cases??[]);
 const live=mode==='case'?caseStatus(data??{})==='open':cases.some(c=>caseStatus(c)==='open')||['confirmed','shipped'].includes(data?.order_status??'');
 const inFlight=useRef(false);
 async function update(silent=false) {
  if(inFlight.current||!canCall)return;
  inFlight.current=true;if(!silent)setBusy(true);
  try {
   const result=mode==='case'&&thisCaseId?await getCase.callTool({case_id:thisCaseId}):orderId?await getOrder.callTool({order_id:orderId}):null;
   if(!result)return;
   const next=readResolution(result.structuredContent);
   if(next.status!=='ok')throw Error(JSON.stringify(next));
   setCurrent(next);setError('');
  }catch(e){setError(readableError(e,'Could not refresh. The details shown are unchanged.'));}
  finally{inFlight.current=false;if(!silent)setBusy(false);}
 }
 const updateRef=useRef(update);updateRef.current=update;
 useEffect(()=>{
  if(!canCall||!live)return;
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void updateRef.current(true);},5000);
  return()=>clearInterval(timer);
 },[canCall,live]);
 const missing=data?.status==='error'&&data.error?.code==='not_found';
 return <section className="exchangent" style={{paddingBottom:Math.max(16,host.safeArea.bottom)}}>
  <header className="panel-header"><span className="brand">⇄ <b>exchangent<span>.</span></b></span><span className="role">{mode==='case'?'Problem case':'Order'}</span></header>
  {context.status==='pending'?<div className="state"><strong>Loading…</strong><p>Your assistant is reading the saved details.</p></div>
  :context.status==='error'?<div className="state"><strong>This view couldn’t load.</strong><p>{readableError(context.error)}</p></div>
  :!data?<div className="state"><strong>These details couldn’t be displayed.</strong><p>Ask your assistant to refresh them.</p></div>
  :data.status==='error'?<div className="state"><strong>{missing?'Not available yet':data.error?.code==='forbidden'?'Choose the right account':'Reconnect to Exchangent'}</strong><p>{missing?'Order tracking and problem cases may not be enabled on this Exchangent server yet, or this ID isn’t yours.':readableError(Error(JSON.stringify(data)))}</p></div>
  :<>
   {mode==='order'?<div className="intro"><span className="eyebrow">{data.seller_name??data.seller?.name?`Sold by ${data.seller_name??data.seller?.name}`:'Your order'}</span><h1>{data.title??'Your order'}</h1>
     <p>{data.total_cents!==undefined?`${money(data.total_cents)} paid`:''}{data.refunded_cents?` · ${money(data.refunded_cents)} refunded`:''}{data.dispute_window_ends_at?` · problems can be reported until ${clock(data.dispute_window_ends_at)}`:''}</p></div>
    :<div className="intro"><span className="eyebrow">{caseStatus(data)==='open'?'Being resolved':caseStatus(data)??'Case'}</span><h1>{caseTypeLabel(data.type)}</h1><p>Proposals are checked by Exchangent against what was paid and the seller’s resolution policy. Refunds go back to the original payment.</p></div>}
   {mode==='order'&&<ol className="order-timeline" aria-label="Order progress">{timeline(data).map(step=><li key={step.label} className={step.done?'done':''}><span className="dot" aria-hidden="true">{step.done?'✓':''}</span><div><strong>{step.label}</strong>{step.at&&<time>{clock(step.at)}</time>}{step.detail&&<small>{step.detail}</small>}</div></li>)}</ol>}
   {mode==='order'&&!!data.items?.length&&<div className="receipt-items">{data.items.map((it,i)=><div key={i}><span>{it.quantity??1} × {it.title??'Item'}</span>{it.unit_cents!==undefined&&<strong>{money((it.quantity??1)*it.unit_cents)}</strong>}</div>)}</div>}
   {error&&<p className="error" role="alert">{error} <button className="text-button" disabled={busy} onClick={()=>void update()}>Try again</button></p>}
   <div className="threads">{cases.length?cases.map((c,i)=><CaseThread key={caseId(c)??i} c={c} viewer={viewer}/>):mode==='order'&&<div className="state"><strong>No problems reported</strong><p>If something is wrong with this order, ask your assistant to report it: missing, damaged, not as described or late.</p></div>}</div>
   {!!(data.refunds?.length)&&<div className="activity"><strong className="refunds-title">Refunds</strong>{data.refunds.map((r,i)=><div className="activity-row" key={i}><strong>{r.amount_cents!==undefined?money(r.amount_cents):'Refund'} · {r.status??'pending'}</strong>{r.reason&&<span>{r.reason}</span>}{r.created_at&&<small>{clock(r.created_at)}</small>}</div>)}</div>}
   <p className="note">Test mode: refunds go back to the Stripe sandbox payment. A “simulated carrier scan” stands in for real carrier tracking, which isn’t connected yet.</p>
   <footer><span aria-live="polite">{busy?'Updating…':live&&canCall?'Live · refreshing every 5 seconds':'Saved · safe to close and reopen'}</span><button className="text-button" disabled={busy||!canCall} onClick={()=>void update()}>Refresh</button></footer>
  </>}
 </section>;
}
