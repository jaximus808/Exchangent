'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,Bot,CheckCircle2,Clock3,Loader2,LockKeyhole,MessageSquareText,PartyPopper,Radio,ShieldCheck,UserRound} from 'lucide-react';
import {agreedDeal,bestOffer,currentOffer,type Conversation} from '@/lib/conversation';
import {api,ApiError,errorText,money,type BuyRequest,type Offer,type OrderStatus} from '@/lib/workspace';
import {Thread} from './thread';
import {Connect} from './connect';
import {Empty,Status} from './ui';
import {BuyerOrders} from './orders';

export const requestTitle=(r:BuyRequest,c?:Conversation|null)=>c?.title||r.title||r.requirements.split('\n')[0].slice(0,80)||'Untitled request';
export const statusText=(status:string)=>({negotiating:'Negotiating',awaiting_payment:'Reserved · pay to finish',confirmed:'Purchased',expired:'Expired · deadline passed'}[status]??status.replaceAll('_',' '));
export const statusTone=(status:string)=>status==='negotiating'?'live' as const:status==='confirmed'?'done' as const:'neutral' as const;
const dateLabel=(d:string)=>new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
export const reservationKey=(userId:string)=>`exchangent-reservation-${userId}`;
const readReservation=(userId:string)=>{try{return localStorage.getItem(reservationKey(userId));}catch{return null;}};

export function RequestCard({request,conv,active,onSelect}:{request:BuyRequest;conv?:Conversation|null;active?:boolean;onSelect?:()=>void}) {
 const best=bestOffer(conv),deal=agreedDeal(conv);
 return <article className={`request-card ${active?'active':''}`}>
  <button className="request-card-main" onClick={onSelect} aria-pressed={active}>
   <div className="request-card-top"><Status tone={statusTone(request.status)}>{deal&&request.status==='negotiating'?'Deal reached':statusText(request.status)}</Status><time>{dateLabel(request.created_at)}</time></div>
   <h3>{requestTitle(request,conv)}</h3>
   <dl className="request-card-facts">
    <div><dt>Best offer</dt><dd>{best?.offer.total_cents!==undefined?money(best.offer.total_cents):'—'}</dd></div>
    <div><dt>Sellers</dt><dd>{conv?conv.sessions.length:'…'}</dd></div>
    <div><dt>Haggling</dt><dd className="chip-dd">{conv?.delegate_negotiation===false?<><UserRound size={12}/>You</>:<><Bot size={12}/>Your agent</>}</dd></div>
   </dl>
  </button>
  <a className="watch-link" href={`/watch/${request.id}`} target="_blank" rel="noopener"><Radio size={14}/>Watch agents<ArrowUpRight size={13}/></a>
 </article>;
}

function Receipt({order}:{order:OrderStatus}) {
 return <article className="receipt"><div className="receipt-head"><CheckCircle2 size={20}/><div><h3>Purchase confirmed</h3><p>Payment verified by Stripe (test mode). {order.seller?.name?`${order.seller.name} has been notified.`:''}</p></div></div>
  <dl className="price-breakdown">{order.items?.map(i=><div key={i.title}><dt>{i.quantity}× {i.title}</dt><dd>{money(i.quantity*i.unit_cents)}</dd></div>)}
   {order.delivery_cents!==undefined&&<div><dt>Delivery</dt><dd>{money(order.delivery_cents)}</dd></div>}
   {order.tax_cents!==undefined&&order.tax_cents>0&&<div><dt>Tax</dt><dd>{money(order.tax_cents)}</dd></div>}
   <div className="total"><dt>Total paid</dt><dd>{money(order.order?.total_cents??order.total_cents)}</dd></div></dl>
  {order.order&&<p className="fine-print left">Order {order.order.id.slice(0,8).toUpperCase()} · {dateLabel(order.order.created_at)}</p>}</article>;
}

function RequestDetail({userId,request,conv,onChanged}:{userId:string;request:BuyRequest;conv?:Conversation|null;onChanged:()=>void}) {
 const[offers,setOffers]=useState<Offer[]>([]);const[order,setOrder]=useState<OrderStatus|null>(null);
 const[busy,setBusy]=useState<string|null>(null);const[error,setError]=useState('');const[now,setNow]=useState(()=>Date.now());
 const keys=useRef<Record<string,string>>({});
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(t);},[]);
 useEffect(()=>{
  let alive=true;setOffers([]);setError('');
  const load=async()=>{
   if(document.visibilityState==='hidden') return;
   try {const rows=await api<Offer[]>(`buy-requests/${request.id}/offers`);if(alive) setOffers(rows);} catch {/* the conversation still shows the offers */}
   const id=readReservation(userId);
   if(id) try {const row=await api<OrderStatus>(`reservations/${id}`);if(alive) setOrder(row.request_id===undefined||row.request_id===request.id?row:null);} catch {if(alive) setOrder(null);}
  };
  void load();const t=setInterval(load,request.status==='negotiating'?4000:12000);
  return()=>{alive=false;clearInterval(t);};
 },[request.id,request.status,userId]);
 const sellerName=(sellerId:string)=>conv?.sessions.find(s=>s.seller_id===sellerId)?.seller_name??'Seller';
 const deal=agreedDeal(conv),best=bestOffer(conv);
 const live=offers.filter(o=>o.is_current&&Date.parse(o.expires_at)>now).sort((a,b)=>a.total_cents-b.total_cents);
 async function checkout(reservationId:string) {
  const payment=await api<{url:string;session_id:string}>(`reservations/${reservationId}/checkout`,{method:'POST'});
  const url=new URL(payment.url);
  if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com'||!payment.session_id.startsWith('cs_test_')) throw new Error('This checkout link could not be verified. Refresh and try again.');
  window.location.assign(url.toString());
 }
 async function reserve(offer:Offer) {
  setBusy(offer.id);setError('');
  try {
   keys.current[offer.id]??=crypto.randomUUID();
   const hold=await api<{id:string}>(`offers/${offer.id}/reservations`,{method:'POST',headers:{'idempotency-key':keys.current[offer.id]},body:JSON.stringify({expected_total_cents:offer.total_cents})});
   try{localStorage.setItem(reservationKey(userId),hold.id);}catch{/* storage blocked: status still loads from the request */}
   onChanged();
   await checkout(hold.id);
  } catch(e) {setError(e instanceof ApiError&&e.code==='request_already_reserved'?'This request already has a reservation. Use “Continue to checkout”.':e instanceof ApiError&&e.code==='price_changed'?'The price changed. Review the updated offer and try again.':errorText(e,'Checkout couldn’t be opened.'));}
  finally {setBusy(null);}
 }
 const reservationId=readReservation(userId);
 const sessions=conv?.sessions??[];
 return <section className="request-detail" aria-labelledby="detail-title">
  <header className="detail-head">
   <div><div className="detail-meta"><Status tone={statusTone(request.status)}>{statusText(request.status)}</Status><span className="mono">REQ {request.id.slice(0,8).toUpperCase()}</span></div><h2 id="detail-title">{requestTitle(request,conv)}</h2>{request.requirements&&request.requirements!==conv?.title&&<p>{request.requirements}</p>}</div>
   <a className="button primary" href={`/watch/${request.id}`} target="_blank" rel="noopener"><Radio size={15}/>Watch agents live</a>
  </header>
  {request.status==='confirmed'&&order?.order?<Receipt order={order}/>:null}
  {deal&&request.status==='negotiating'&&<div className="deal-callout"><PartyPopper size={18}/><div><strong>Your agent reached a deal: {deal.session.seller_name}, {money(deal.offer.total_cents!)}</strong><span>Nothing is reserved or charged until you approve it below.</span></div></div>}
  {request.status==='awaiting_payment'&&reservationId&&<div className="deal-callout"><LockKeyhole size={18}/><div><strong>Your items are on hold.</strong><span>Finish the Stripe test checkout to confirm the order.</span></div><button className="button primary compact" disabled={busy!==null} onClick={()=>{setBusy('checkout');checkout(reservationId).catch(e=>setError(errorText(e))).finally(()=>setBusy(null));}}>{busy==='checkout'?<Loader2 size={14} className="spin"/>:null}Continue to checkout</button></div>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="detail-section"><div className="section-heading"><h2>Current offers <span className="number-tag">{live.length}</span></h2><span className="toolbar-caption"><ShieldCheck size={13}/>You approve every payment</span></div>
   {live.length?<div className="offer-rows">{live.map(o=>{const name=sellerName(o.seller_id);const isBest=best?.offer.offer_id===o.id;return <div className={`offer-row ${isBest?'best':''}`} key={o.id}>
    <div className="offer-row-name"><strong>{name}</strong><span><Clock3 size={12}/>Expires {new Date(o.expires_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}{o.delivery_cents?` · ${money(o.delivery_cents)} delivery`:' · free delivery'}</span></div>
    <div className="offer-row-price">{money(o.total_cents)}{isBest&&<span>Lowest</span>}</div>
    <button className="button secondary compact" disabled={busy!==null||request.status!=='negotiating'} onClick={()=>void reserve(o)}>{busy===o.id?<Loader2 size={14} className="spin"/>:<LockKeyhole size={13}/>}Reserve & pay</button>
   </div>;})}</div>:<p className="muted small-copy">{request.status==='negotiating'?'Offers appear as sellers’ agents respond.':'No open offers on this request.'}</p>}
  </div>
  <div className="detail-section"><div className="section-heading"><h2><MessageSquareText size={16}/>How the agents talked</h2><a className="text-button" href={`/watch/${request.id}`} target="_blank" rel="noopener">Open live view<ArrowUpRight size={13}/></a></div>
   {sessions.length?<div className="conversation-list">{sessions.map(s=><details key={s.session_id} className="conversation-card" open={s.session_id===(deal?.session.session_id??best?.session.session_id)}>
    <summary><strong>{s.seller_name}</strong><span>{currentOffer(s)?.total_cents!==undefined?money(currentOffer(s)!.total_cents!):s.status==='declined'?'Declined':'No offer yet'}</span><span className="muted">{(n=>`${n} message${n===1?'':'s'}`)(s.messages.filter(m=>m.kind!=='opened').length)}</span></summary>
    <Thread session={s} conversation={conv??null} perspective="buyer" now={now}/>
   </details>)}</div>:<p className="muted small-copy">{conv?'No seller matched this request yet.':'Loading the conversation…'}</p>}
  </div>
 </section>;
}

export function Buying({userId,requests,convs,loading,selected,onSelect,onChanged}:{userId:string;requests:BuyRequest[];convs:Record<string,Conversation|null>;loading:boolean;selected:string;onSelect:(id:string)=>void;onChanged:()=>void}) {
 const active=requests.find(r=>r.id===selected)??requests[0];
 if(loading) return <div className="skeleton-wrap" aria-label="Loading requests"><div className="skeleton large"/><div className="skeleton"/></div>;
 if(!requests.length) return <div className="stack-gap"><Empty title="No requests yet." icon={<MessageSquareText size={30} strokeWidth={1.2}/>}>Ask Claude for what you need. Your request, every seller’s offer and the whole negotiation show up here.</Empty><BuyerOrders/><Connect/></div>;
 return <div className="stack-gap"><div className="buying-grid">
  <div className="request-list" role="list">{requests.map(r=><div role="listitem" key={r.id}><RequestCard request={r} conv={convs[r.id]} active={active?.id===r.id} onSelect={()=>onSelect(r.id)}/></div>)}</div>
  {active&&<RequestDetail key={active.id} userId={userId} request={active} conv={convs[active.id]} onChanged={onChanged}/>}
 </div><BuyerOrders/></div>;
}
