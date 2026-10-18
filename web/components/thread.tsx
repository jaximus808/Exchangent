'use client';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ArrowRightLeft,CircleSlash,Radio} from 'lucide-react';
import {ago,hopLabel,mine,speaker,type ConvMessage,type ConvSession,type Conversation,type Perspective} from '@/lib/conversation';
import {money} from '@/lib/workspace';
import './thread.css';

function Hop({message}:{message:ConvMessage}) {
 const hop=hopLabel(message.delivery);
 if(!hop) return null;
 return <span className="hop" title={message.delivery?.context_id?`A2A context ${message.delivery.context_id}`:undefined}><span className="hop-label"><ArrowRightLeft size={11} aria-hidden="true"/> {hop.label}</span>{hop.detail&&<span className="hop-id">{hop.detail}</span>}</span>;
}

function Bubble({message,session,conversation,perspective,now}:{message:ConvMessage;session:ConvSession;conversation:Pick<Conversation,'delegate_negotiation'>|null;perspective:Perspective;now:number}) {
 if(message.kind==='opened') return <div className="thread-system"><Radio size={12} aria-hidden="true"/><span>Negotiation opened with {session.seller_name}</span><time>{ago(message.at,now)}</time><Hop message={message}/></div>;
 const own=mine(message,perspective);
 const who=speaker(message,session,conversation,perspective);
 const declined=message.kind==='declined';
 return <div className={`bubble-row ${own?'own':'other'}`}>
  <div className={`bubble ${message.kind} ${message.by}`}>
   <div className="bubble-head"><strong>{who}</strong><span>{declined?'declined':message.kind==='counter'?'countered':message.version===1?'opened at':'offered'}</span><time>{ago(message.at,now)}</time></div>
   {declined?<p className="bubble-note"><CircleSlash size={13} aria-hidden="true"/>{message.reason||message.note||'No longer negotiating.'}</p>:<>
    {message.total_cents!==undefined&&<div className="bubble-price">{money(message.total_cents)}</div>}
    {message.note&&<p className="bubble-note">“{message.note}”</p>}
   </>}
   <Hop message={message}/>
  </div>
 </div>;
}

/** One negotiation as a chat thread. The viewer's side (perspective) sits on the right. */
export function Thread({session,conversation,perspective,now,emptyText='Waiting for the first move…'}:{session:ConvSession;conversation:Pick<Conversation,'delegate_negotiation'>|null;perspective:Perspective;now:number;emptyText?:string}) {
 const reduced=useReducedMotion();
 const messages=session.messages;
 return <div className="thread" aria-live="polite">
  {messages.length===0&&<p className="thread-empty">{emptyText}</p>}
  <AnimatePresence initial={false}>
   {messages.map((m,i)=><motion.div key={`${m.kind}-${m.offer_id??m.counter_id??i}-${m.at}`} layout={!reduced} initial={reduced?false:{opacity:0,y:14,scale:.98}} animate={{opacity:1,y:0,scale:1}} transition={{duration:.32,ease:[.16,1,.3,1]}}>
    <Bubble message={m} session={session} conversation={conversation} perspective={perspective} now={now}/>
   </motion.div>)}
  </AnimatePresence>
 </div>;
}
