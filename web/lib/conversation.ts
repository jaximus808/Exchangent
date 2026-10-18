// Shapes and pure helpers for the agent conversation (doc/conversation-contract.md). The backend builds
// these from offers, counters and the outbox delivery receipts; nothing here sees floors or budgets.

export type Delivery={transport?:string;from_handle?:string;to_handle?:string;message_id?:string;context_id?:string;delivered_at?:string};
export type ConvMessage={
 kind:'opened'|'offer'|'counter'|'declined';by:'buyer'|'seller'|'platform';
 total_cents?:number;note?:string|null;reason?:string|null;version?:number;offer_id?:string;counter_id?:string;
 at:string;delivery?:Delivery|null;
};
export type ConvSession={
 session_id:string;seller_id:string;seller_name:string;status:string;turn?:string|null;rounds?:number;
 seller_agent?:boolean;seller_handle?:string|null;opened_at?:string;messages:ConvMessage[];
 request_id?:string;title?:string|null;request_title?:string|null;request_status?:string|null;
};
export type Conversation={request_id:string;title?:string|null;status:string;delegate_negotiation?:boolean;sessions:ConvSession[]};
export type Perspective='buyer'|'seller';

/** The seller's latest offer in an open session, or null. */
export function currentOffer(s:ConvSession):ConvMessage|null {
 if(s.status!=='open') return null;
 for(let i=s.messages.length-1;i>=0;i--) if(s.messages[i].kind==='offer') return s.messages[i];
 return null;
}
function lastCounter(s:ConvSession,before=s.messages.length):ConvMessage|null {
 for(let i=before-1;i>=0;i--) if(s.messages[i].kind==='counter') return s.messages[i];
 return null;
}
/** Lowest current offer across open sessions. */
export function bestOffer(c:Conversation|null|undefined):{session:ConvSession;offer:ConvMessage}|null {
 let best:{session:ConvSession;offer:ConvMessage}|null=null;
 for(const session of c?.sessions??[]) {
  const offer=currentOffer(session);
  if(offer?.total_cents!==undefined&&(!best||offer.total_cents<(best.offer.total_cents??Infinity))) best={session,offer};
 }
 return best;
}
/**
 * A seller met the buyer's own counter: the latest message in an open session is an offer at or below the
 * buyer's previous counter. That is the moment the buyer agent stops and tells the human.
 */
export function agreedDeal(c:Conversation|null|undefined):{session:ConvSession;offer:ConvMessage}|null {
 const deals=(c?.sessions??[]).flatMap(session=>{
  const last=session.messages.at(-1);
  if(session.status!=='open'||last?.kind!=='offer'||last.total_cents===undefined) return [];
  const counter=lastCounter(session,session.messages.length-1);
  return counter?.total_cents!==undefined&&last.total_cents<=counter.total_cents?[{session,offer:last}]:[];
 });
 return deals.sort((a,b)=>(a.offer.total_cents??0)-(b.offer.total_cents??0))[0]??null;
}
export function speaker(m:ConvMessage,s:ConvSession,c:{delegate_negotiation?:boolean}|null,perspective:Perspective):string {
 if(m.by==='platform') return 'Exchangent';
 const buyerAgent=c?.delegate_negotiation!==false;
 if(m.by==='buyer') return perspective==='buyer'?(buyerAgent?'Your agent':'You'):(buyerAgent?'Buyer’s agent':'Buyer');
 return perspective==='seller'?(s.seller_agent!==false?'Your agent':'You'):(s.seller_agent!==false?`${s.seller_name} agent`:s.seller_name);
}
/** Which side of the thread a message sits on: the viewer's own side is on the right. */
export const mine=(m:ConvMessage,perspective:Perspective)=>m.by===perspective;
export function hopLabel(d:Delivery|null|undefined):{label:string;detail?:string}|null {
 if(!d) return null;
 const id=d.message_id?`#${d.message_id.slice(0,8)}`:undefined;
 if(d.transport==='inkbox') return {label:`Inkbox A2A · ${d.from_handle??'agent'} → ${d.to_handle??'agent'}`,detail:id};
 if(d.transport==='local') return {label:'Delivered in-process',detail:id};
 return {label:`Delivered via ${d.transport??'runner'}`,detail:id};
}
export const firstAt=(c:Conversation|null|undefined)=>{
 const times=(c?.sessions??[]).flatMap(s=>[s.opened_at,...s.messages.map(m=>m.at)]).filter((t):t is string=>!!t).map(t=>Date.parse(t)).filter(Number.isFinite);
 return times.length?Math.min(...times):null;
};
export const lastAt=(c:Conversation|null|undefined)=>{
 const times=(c?.sessions??[]).flatMap(s=>s.messages.map(m=>Date.parse(m.at))).filter(Number.isFinite);
 return times.length?Math.max(...times):null;
};
export function duration(ms:number) {
 const s=Math.max(0,Math.floor(ms/1000));
 return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`:`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`;
}
export function ago(at:string,now:number) {
 const s=Math.max(0,Math.round((now-Date.parse(at))/1000));
 if(!Number.isFinite(s)) return '';
 return s<5?'just now':s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:s<86400?`${Math.floor(s/3600)}h ago`:new Date(at).toLocaleDateString('en-US',{month:'short',day:'numeric'});
}
export const messageCount=(c:Conversation|null|undefined)=>(c?.sessions??[]).reduce((n,s)=>n+s.messages.filter(m=>m.kind!=='opened').length,0);
