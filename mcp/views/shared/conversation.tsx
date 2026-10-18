import {useEffect,useRef,useState} from 'react';
import {useCallTool,useHostContext,useOpenExternal,useToolContext} from 'mcp-use/react';
import {money} from './data.js';
import {bestOffer,hopLine,readConversation,speaker,type Conversation,type Message,type Thread} from './conversation-data.js';
import {readableError} from './presentation.js';
import './style.css';

const clock=(at?:string)=>{if(!at)return '';const t=new Date(at);return Number.isNaN(t.getTime())?'':t.toLocaleTimeString([],{hour:'numeric',minute:'2-digit',second:'2-digit'});};

function Bubble({m,s,delegated}:{m:Message;s:Thread;delegated?:boolean}) {
 if(m.kind==='opened')return <li className="chat-system">Exchangent matched {s.seller_name??'a seller'} · negotiation opened <time>{clock(m.at)}</time></li>;
 if(m.kind==='declined')return <li className="chat-system">{m.by==='buyer'?speaker(m,s,delegated):s.seller_name??'Seller'} declined{m.reason?`: ${m.reason}`:''} <time>{clock(m.at)}</time></li>;
 const hop=hopLine(m);
 return <li className={`chat-bubble ${m.by==='buyer'?'mine':'theirs'}`}>
  <div className="chat-meta"><strong>{speaker(m,s,delegated)}</strong><span>{m.kind==='counter'?'Counter':'Offer'}</span><time>{clock(m.at)}</time></div>
  {m.total_cents!==undefined&&<span className="chat-price">{money(m.total_cents)}</span>}
  {m.note&&<p>{m.note}</p>}
  {hop&&<small className="chat-hop">{hop}</small>}
 </li>;
}

export function ConversationPanel() {
 const context=useToolContext<'get_conversation'>(),host=useHostContext(),open=useOpenExternal();
 const getConversation=useCallTool('get_conversation');
 const [current,setCurrent]=useState<Conversation|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const parsed=context.status==='ready'?(()=>{try{return readConversation(context.toolOutput);}catch{return null;}})():null;
 const data=current??parsed;
 const input=context.toolInput as {request_id?:string}|undefined;
 const requestId=data?.request_id??input?.request_id;
 const canCall=host.isAvailable&&!!host.hostCapabilities?.serverTools;
 const live=!!data?.sessions?.some(s=>s.status==='open')&&data?.request_status==='negotiating';
 const inFlight=useRef(false);
 async function update(silent=false) {
  if(inFlight.current||!canCall||!requestId)return;
  inFlight.current=true;if(!silent)setBusy(true);
  try {
   const result=await getConversation.callTool({request_id:requestId});
   const next=readConversation(result.structuredContent);
   if(next.status!=='ok')throw Error(JSON.stringify(next));
   setCurrent(next);setError('');
  }catch(e){setError(readableError(e,'Could not refresh. The conversation so far is unchanged.'));}
  finally{inFlight.current=false;if(!silent)setBusy(false);}
 }
 const updateRef=useRef(update);updateRef.current=update;
 // The bridge can call server tools: refresh every 3 s while any negotiation is open.
 useEffect(()=>{
  if(!canCall||!live)return;
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void updateRef.current(true);},3000);
  return()=>clearInterval(timer);
 },[canCall,live]);
 const best=data?bestOffer(data):null;
 const turns=(data?.sessions??[]).reduce((n,s)=>n+(s.messages??[]).filter(m=>m.kind==='offer'||m.kind==='counter').length,0);
 return <section className="exchangent" style={{paddingBottom:Math.max(16,host.safeArea.bottom)}}>
  <header className="panel-header"><span className="brand">⇄ <b>exchangent<span>.</span></b></span><span className="role">Agent conversation</span></header>
  {context.status==='pending'?<div className="state"><strong>Loading the conversation…</strong><p>Your assistant is reading the negotiation.</p></div>
  :context.status==='error'?<div className="state"><strong>This view couldn’t load.</strong><p>{readableError(context.error)}</p></div>
  :!data?<div className="state"><strong>This conversation couldn’t be displayed.</strong><p>Ask your assistant to refresh it.</p></div>
  :data.status==='error'?<div className="state"><strong>{data.error?.code==='forbidden'?'Choose your buyer account':'Reconnect to Exchangent'}</strong><p>Only the buyer who placed this order can watch its negotiation.</p></div>
  :<>
   <div className="intro"><span className="eyebrow">{live?'Agents negotiating · live':'How the agents negotiated'}</span><h1>{data.title??'Your buying request'}</h1>
    <p>{turns} {turns===1?'turn':'turns'} across {data.sessions?.length??0} {(data.sessions?.length??0)===1?'business':'businesses'}{best?` · best current offer ${money(best.total)} from ${best.seller}`:''}. Every turn is checked by Exchangent before it counts.</p></div>
   {data.watch_url&&<button className="button secondary" disabled={!host.hostCapabilities?.openLinks} onClick={()=>void open({url:data.watch_url!})}>Open live view ↗</button>}
   {error&&<p className="error" role="alert">{error} <button className="text-button" disabled={busy} onClick={()=>void update()}>Try again</button></p>}
   <div className="threads">{(data.sessions??[]).length?(data.sessions??[]).map(s=><article className="thread" key={s.session_id}>
    <div className="thread-head"><h2>{s.seller_name??'Seller'}</h2><span>{s.seller_agent===false?'Owner in chat':'Seller agent'} · {s.status==='open'?`round ${s.rounds??0} · ${s.turn==='seller'?'seller’s turn':'your side’s turn'}`:s.status??''}</span></div>
    <ol className="chat">{(s.messages??[]).map((m,i)=><Bubble key={i} m={m} s={s} delegated={data.delegate_negotiation}/>)}</ol>
   </article>):<div className="state"><strong>No businesses matched yet</strong><p>Threads appear here as soon as a seller is matched.</p></div>}</div>
   <p className="note">Agents notify each other over Inkbox A2A; prices and rules live in Exchangent, so a message alone can’t change a deal. Seller minimums and your budget are never shown.</p>
   <footer><span aria-live="polite">{busy?'Updating…':live&&canCall?'Live · refreshing every 3 seconds':'Saved · safe to close and reopen'}</span><button className="text-button" disabled={busy||!canCall} onClick={()=>void update()}>Refresh</button></footer>
  </>}
 </section>;
}
