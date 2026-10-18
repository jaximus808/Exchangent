import {agreedDeal,type ConvSession,type Conversation} from './conversation.ts';

export function sellerOffer(session:ConvSession,now=Date.now()) {
 const offers=session.messages.filter(m=>m.kind==='offer');
 const latest=offers.at(-1);
 const total=session.current_offer?.total_cents??latest?.total_cents;
 const expires=session.current_offer?.expires_at;
 return {opening:offers[0]?.total_cents,total,
  eligible:session.status==='open'&&!!session.current_offer&&typeof total==='number'&&!!expires&&Date.parse(expires)>now,
  expired:!!expires&&Date.parse(expires)<=now};
}
export function watchState(conversation:Conversation|null,now=Date.now()) {
 if(!conversation)return {label:'Connecting',step:0,live:false,kind:'loading' as const};
 const r=conversation.reservation;
 if(conversation.status==='confirmed'&&r?.status==='consumed')return {label:'Order confirmed',step:3,live:false,kind:'confirmed' as const};
 if(r?.status==='payment_pending'||conversation.status==='confirmed')return {label:'Verifying payment',step:3,live:false,kind:'verifying' as const};
 if(conversation.status==='awaiting_payment'&&r&&['expired','released','cancelled','failed'].includes(r.status))return {label:r.status==='expired'?'Reservation expired':'Checkout ended',step:2,live:false,kind:'ended' as const};
 if(conversation.status==='awaiting_payment')return {label:'Awaiting payment',step:2,live:false,kind:'approval' as const};
 if(conversation.status==='negotiating'&&!conversation.sessions.length)return {label:'No matching sellers',step:0,live:false,kind:'ended' as const};
 if(conversation.status==='negotiating'&&conversation.sessions.every(s=>s.status!=='open'))return {label:'No active sellers',step:1,live:false,kind:'ended' as const};
 const deal=agreedDeal(conversation,now);
 if(conversation.status==='negotiating'&&deal&&sellerOffer(deal.session,now).eligible)return {label:'Offers ready for review',step:2,live:true,kind:'review' as const};
 if(conversation.status==='negotiating')return {label:conversation.sessions.length?'Negotiating':'Finding sellers',step:conversation.sessions.length?1:0,live:true,kind:'negotiating' as const};
 return {label:conversation.status.replaceAll('_',' '),step:1,live:false,kind:'ended' as const};
}
export function selectedSeller(conversation:Conversation|null) {
 const reservation=conversation?.reservation;
 if(!reservation||!['held','checkout_open','payment_pending','consumed'].includes(reservation.status))return null;
 return conversation?.sessions.find(s=>s.seller_id===reservation.seller_id||s.messages.some(m=>m.offer_id===reservation.offer_id))??null;
}
export const orderLink=(requestId:string)=>`/?request=${encodeURIComponent(requestId)}#buying`;

/** Keep missing requests distinct from ownership failures, without exposing another buyer's data. */
export function watchAccess(status:number) {
 return status===401?'signed_out':status===403?'not_yours':status===404?'not_found':null;
}
