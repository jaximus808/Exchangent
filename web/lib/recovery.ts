import type {Conversation} from './conversation.ts';
export type ViewCheckpoint={version:1;request:string;actor:string;at:number;events:string[]};
export const checkpointKey=(actor:string,request:string)=>`exchangent-view-v1:${encodeURIComponent(actor)}:${encodeURIComponent(request)}`;
export function eventKeys(c:Conversation) {
 return [...new Set(c.sessions.flatMap(s=>s.messages.filter(m=>m.kind!=='opened').map((m,i)=>`${s.session_id}:${m.kind}:${m.offer_id??m.counter_id??`${m.at}:${i}`}`)))];
}
export function checkpoint(c:Conversation,actor:string,now=Date.now()):ViewCheckpoint|null {
 const events=eventKeys(c);return events.length>5000?null:{version:1,request:c.request_id,actor,at:now,events};
}
export function restoreNotice(raw:string|null,c:Conversation,actor:string,now=Date.now()) {
 if(!raw)return null;
 try{const saved=JSON.parse(raw) as ViewCheckpoint;
  if(saved.version!==1||saved.actor!==actor||saved.request!==c.request_id||!Number.isFinite(saved.at)||saved.at>now||now-saved.at>7*86400000||!Array.isArray(saved.events)||saved.events.length>5000||!saved.events.every(e=>typeof e==='string'))return null;
  const prior=new Set(saved.events),current=eventKeys(c);
  return {newMoves:current.filter(key=>!prior.has(key)).length,seenAt:saved.at};
 }catch{return null;}
}
