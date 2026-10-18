import type {ConvSession,ConvMessage} from './conversation.ts';
const keyOf=(s:ConvSession,m:ConvMessage)=>`${s.session_id}-${m.kind}-${m.offer_id??m.counter_id??m.at}-${m.at}`;
/** Initial history and older snapshots never play as new traffic. One packet per latest move. */
export function recordedMoves(sessions:ConvSession[],previous:Set<string>|null) {
 const seen=new Set(previous??[]),moves:Record<string,{key:string;buyer:boolean}>={};
 for(const s of sessions){
  const messages=s.messages.filter(m=>m.kind!=='opened'),last=messages.at(-1);
  if(last&&previous&&!previous.has(keyOf(s,last))&&last.by!=='platform')moves[s.session_id]={key:keyOf(s,last),buyer:last.by==='buyer'};
  for(const m of messages)seen.add(keyOf(s,m));
 }
 return {seen,moves};
}
