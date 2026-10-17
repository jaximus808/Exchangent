import {useEffect,useRef,useState} from 'react';
import {useCallTool,useHostContext,useOpenExternal,useSendFollowUp,useToolContext} from 'mcp-use/react';
import {checkoutUrl,money,readPayload,type Offer,type Payload} from './data.js';
import './style.css';

type Kind='buyer'|'offers'|'seller'|'checkout';
function Note({children}:{children:React.ReactNode}) {return <p className="note">{children}</p>;}
function State({title,children}:{title:string;children:React.ReactNode}) {return <div className="state"><strong>{title}</strong><p>{children}</p></div>;}

export function Panel({kind}:{kind:Kind}) {
 const context=useToolContext<'get_buy_order'>();
 const host=useHostContext();
 const [current,setCurrent]=useState<Payload|null>(null);
 const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const getBuyer=useCallTool('get_buy_order');const getOffers=useCallTool('list_offers');
 const getInventory=useCallTool('get_inventory');const getSeller=useCallTool('list_my_requests');const getSession=useCallTool('get_negotiation');
 const getStatus=useCallTool('get_reservation_status');
 const followUp=useSendFollowUp();
 const pollBusy=useRef(false);
 const parsed=context.status==='ready'?payloadSchemaResult(context.toolOutput):null;
 const data=current??parsed;
 const input=context.toolInput as {request_id?:string;reservation_id?:string;session_id?:string}|undefined;
 const requestId=data?.request_id??input?.request_id;
 const reservationId=data?.reservation_id??data?.reservation?.reservation_id??input?.reservation_id;
 const canCall=host.isAvailable&&!!host.hostCapabilities?.serverTools;
 async function update(silent=false) {
  if(pollBusy.current||!canCall)return;
  pollBusy.current=true;if(!silent)setBusy(true);
  try {
   let result;
   if(reservationId)result=await getStatus.callTool({reservation_id:reservationId});
   else if(kind==='seller'&&(data?.session_id??input?.session_id))result=await getSession.callTool({session_id:data?.session_id??input!.session_id!});
   else if(kind==='seller'&&data?.inventory)result=await getInventory.callTool({});
   else if(kind==='seller')result=await getSeller.callTool({status:'open'});
   else if(kind==='offers'&&requestId)result=await getOffers.callTool({request_id:requestId});
   else if(requestId)result=await getBuyer.callTool({request_id:requestId});
   if(result){const next=readPayload(result.structuredContent);if(next.status!=='ok')throw Error(next.next??'Could not refresh.');setCurrent(old=>({...parsed,...old,...next}));setError('');}
  }catch(e){setError(e instanceof Error?e.message:'Could not refresh. Ask your assistant to check the latest state.');}
  finally{pollBusy.current=false;if(!silent)setBusy(false);}
 }
 const updateRef=useRef(update);updateRef.current=update;
 useEffect(()=>{
  if(!canCall||data?.order?.status==='confirmed'||data?.request_status==='confirmed')return;
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void updateRef.current(true);},5000);
  const visible=()=>{if(document.visibilityState==='visible')void updateRef.current(true);};
  document.addEventListener('visibilitychange',visible);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[canCall,data?.order?.status,data?.request_status]);
 async function ask(prompt:string) {setBusy(true);try{await followUp({prompt});setError('');}catch{setError('The host could not send that message. Type the request in your chat instead.');}finally{setBusy(false);}}
 return <section className="exchangent" style={{paddingBottom:Math.max(16,host.safeArea.bottom)}}>
  <header className="panel-header"><span className="brand">⇄ <b>exchangent<span>.</span></b></span><span className="role">{kind==='seller'&&data?.role!=='buyer'?'Business workspace':kind==='checkout'?'Your purchase':'Buyer workspace'}</span></header>
  {context.status==='pending'?<State title="Getting your latest details…">Your assistant is checking the saved state.</State>:context.status==='error'?<State title="This view couldn’t load.">{context.error.message}</State>:!data?<State title="These details couldn’t be displayed.">Ask your assistant to refresh the request.</State>:<>
   {error&&<p className="error" role="alert">{error}</p>}
   {kind==='checkout'?<Checkout data={data} reservationId={reservationId} onChange={setCurrent}/>:kind==='seller'?<Seller data={data} busy={busy} canAsk={!!host.hostCapabilities?.message} ask={ask}/>:<Buyer data={data} requestId={requestId} onChange={setCurrent} canAsk={!!host.hostCapabilities?.message} ask={ask} busy={busy}/>}
   <footer><span aria-live="polite">{busy?'Updating…':'Saved state · refreshes while open'}</span>{<button className="text-button" disabled={busy||!canCall} onClick={()=>void update()}>Refresh</button>}</footer>
  </>}
 </section>;
}
function payloadSchemaResult(value:unknown):Payload|null {try{return readPayload(value);}catch{return null;}}

function Requirements({data}:{data:Payload['requirements']}) {
 if(!data)return null;
 return <div className="requirements">{data.items?.map((item,i)=><span key={i}>{item.quantity??1} × {item.category}{item.max_width_in?` ≤ ${item.max_width_in}″`:''}{item.ergonomic?' · ergonomic':''}</span>)}{data.region&&<span>{data.region.replaceAll('_',' ')}</span>}{data.notes&&<p>{data.notes}</p>}</div>;
}

function Buyer({data,requestId,onChange,canAsk,ask,busy}:{data:Payload;requestId?:string;onChange:(d:Payload)=>void;canAsk:boolean;ask:(s:string)=>Promise<void>;busy:boolean}) {
 const [selected,setSelected]=useState<Offer|null>(null);
 const offers=data.offers??data.sessions?.filter(s=>s.status==='open'&&s.current_offer?.is_current).map(s=>({...s.current_offer!,seller_name:s.seller_name,session_id:s.session_id}))??[];
 const expired=(o:Offer)=>!o.expires_at||!Number.isFinite(Date.parse(o.expires_at))||Date.parse(o.expires_at)<=Date.now();
 const sorted=[...offers].sort((a,b)=>(a.total_cents??Infinity)-(b.total_cents??Infinity));
 if(data.reservation_id||data.reservation)return <Checkout data={data} reservationId={data.reservation_id??data.reservation?.reservation_id} onChange={onChange}/>;
 return <><div className="intro"><span className="eyebrow">{offers.length?'Offers for your review':'Request received'}</span><h1>{data.title??'Better offers. Your final say.'}</h1><p>{data.budget_cents!==undefined?`${money(data.budget_cents)} all-in limit · private to you`:'Businesses compete on the terms that matter to you.'}</p></div>
  <Requirements data={data.requirements}/><div className="offers">{sorted.length?sorted.map(offer=><article className="offer" key={offer.offer_id}><div className="offer-heading"><div><h2>{offer.seller_name??'Seller offer'}</h2><p>{offer.items?.map(i=>`${i.quantity??1} × ${i.title??i.category??'item'}`).join(' · ')}</p></div><strong className="price">{offer.total_cents!==undefined?money(offer.total_cents):'Total unavailable'}</strong></div><div className="offer-terms"><span>Delivery {money(offer.delivery_cents??0)} · tax {money(offer.tax_cents??0)}</span><span>{expired(offer)?'Offer expired':offer.expires_at?`Valid until ${new Date(offer.expires_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:''}</span></div>{offer.note&&<p className="seller-note">{offer.note}</p>}<button className="button secondary" disabled={expired(offer)||offer.total_cents===undefined||(data.budget_cents!==undefined&&offer.total_cents>data.budget_cents)} onClick={()=>setSelected(offer)}>{data.budget_cents!==undefined&&offer.total_cents!>data.budget_cents?'Above your limit':'Review offer'}</button></article>):<State title={data.sessions?.length?`${data.sessions.length} businesses matched`:'Waiting for matching businesses'}>Responses appear here when businesses make an offer. You can close this panel and ask your assistant for an update later.</State>}</div>
  {selected&&<Purchase offer={selected} onClose={()=>setSelected(null)} onChange={onChange}/>}
  {!!data.sessions?.length&&<details className="activity"><summary>Negotiation activity</summary>{data.sessions.map(s=><div className="activity-row" key={s.session_id}><strong>{s.seller_name}</strong><span>{s.status==='declined'?`Declined${s.decline_reason?`: ${s.decline_reason}`:''}`:s.turn==='seller'?'Waiting for seller response':'Seller response received'}</span>{s.latest_counter&&<small>Last counter: {money(s.latest_counter.total_cents)}</small>}{s.current_offer?.total_cents!==undefined&&<small>Current offer: {money(s.current_offer.total_cents)} · round {s.rounds??1}</small>}</div>)}</details>}
  {canAsk&&requestId&&<button className="button secondary full" disabled={busy} onClick={()=>void ask(`Review request ${requestId} and negotiate with the matched businesses within my existing requirements and budget. Do not reserve or pay without my approval.`)}>Ask my agent to negotiate</button>}
  <Note>Nothing is purchased until you approve an offer and pay in Stripe.</Note>
 </>;
}

function Purchase({offer,onClose,onChange}:{offer:Offer;onClose:()=>void;onChange:(d:Payload)=>void}) {
 const reserve=useCallTool('reserve_offer');const checkout=useCallTool('get_checkout_link');
 const host=useHostContext();const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 const hold=useRef<string|null>(null);const key=useRef(crypto.randomUUID());
 async function approve(){if(!offer.offer_id)return;setBusy(true);try{
  if(!hold.current){const r=readPayload((await reserve.callTool({offer_id:offer.offer_id,expected_total_cents:offer.total_cents,idempotency_key:key.current})).structuredContent);hold.current=r.reservation_id??(typeof r.id==='string'?r.id:null);if(!hold.current)throw Error(r.next??'Reservation could not be created.');}
  const payment=readPayload((await checkout.callTool({reservation_id:hold.current})).structuredContent);
  if(!checkoutUrl(payment))throw Error('Checkout link could not be verified. Ask your assistant to check this reservation.');
  onChange({...payment,reservation_id:hold.current,total_cents:offer.total_cents,items:offer.items,subtotal_cents:offer.items?.reduce((n,i)=>n+(i.quantity??1)*(i.unit_cents??0),0),delivery_cents:offer.delivery_cents,tax_cents:offer.tax_cents});
 }catch(e){setError(e instanceof Error?e.message:'Checkout could not be prepared. Recheck this request before trying again.');}finally{setBusy(false);}}
 return <section className="review" aria-label="Review selected offer"><div className="section-title"><h2>Review your selection</h2><button className="text-button" disabled={busy} onClick={onClose}>Close</button></div><p>{offer.seller_name}</p><dl><div><dt>Items</dt><dd>{money(offer.items?.reduce((n,i)=>n+(i.quantity??1)*(i.unit_cents??0),0)??0)}</dd></div><div><dt>Delivery</dt><dd>{money(offer.delivery_cents??0)}</dd></div><div><dt>Tax</dt><dd>{money(offer.tax_cents??0)}</dd></div><div className="total"><dt>Total</dt><dd>{money(offer.total_cents??0)}</dd></div></dl>{error&&<p role="alert" className="error">{error}</p>}<button className="button primary full" disabled={busy||!host.hostCapabilities?.serverTools} onClick={()=>void approve()}>{busy?'Preparing checkout…':`Reserve for ${money(offer.total_cents??0)} & prepare checkout`}</button><Note>Sandbox only. This reserves the goods; you approve payment separately in Stripe.</Note></section>;
}

function Checkout({data,reservationId,onChange}:{data:Payload;reservationId?:string;onChange:(d:Payload)=>void}) {
 const host=useHostContext();const open=useOpenExternal();const link=useCallTool('get_checkout_link');
 const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 const paid=data.reservation_status==='consumed'&&data.order?.status==='confirmed';const processing=data.reservation_status==='payment_pending';const ended=['expired','failed','cancelled'].includes(data.reservation_status??data.reservation?.status??'');
 const url=checkoutUrl(data);
 async function launch(){setBusy(true);try{let target=url;if(!target){if(!reservationId)throw Error('Ask your assistant to recover the reservation.');const p=readPayload((await link.callTool({reservation_id:reservationId})).structuredContent);target=checkoutUrl(p);onChange({...data,...p});}if(!target)throw Error('No verified test checkout link is available.');await open({url:target});}catch(e){setError(e instanceof Error?e.message:'Checkout could not be opened.');}finally{setBusy(false);}}
 return <><div className="intro"><span className="eyebrow">{paid?'Payment verified':ended?'Reservation ended':processing?'Payment processing':'Your approval required'}</span><h1>{paid?'Your order is confirmed.':ended?'Choose a current offer.':processing?'Payment is processing.':'Your items are reserved.'}</h1><p>{paid?'Stripe payment has been verified by the backend.':ended?'Ask your assistant to refresh the available offers.':processing?'Your payment is being verified. You do not need to pay again.':'Complete checkout in Stripe. This panel confirms the order after payment is verified.'}</p></div><div className="receipt"><span>{paid?'Total paid':'Reservation total'}</span>{(data.order?.total_cents??data.total_cents??data.reservation?.total_cents)!==undefined&&<strong>{money((data.order?.total_cents??data.total_cents??data.reservation?.total_cents)!)}</strong>}{paid&&<small>Order {data.order!.id.slice(0,8).toUpperCase()}</small>}</div>{data.seller&&<p className="note">Sold by {data.seller.name}</p>}{!!data.items?.length&&<div className="receipt-items">{data.items.map((item,i)=><div key={i}><span>{item.quantity??1} × {item.title??'Item'}</span><strong>{money((item.quantity??1)*(item.unit_cents??0))}</strong></div>)}{data.delivery_cents!==undefined&&<div><span>Delivery</span><strong>{money(data.delivery_cents)}</strong></div>}{data.tax_cents!==undefined&&<div><span>Demo tax</span><strong>{money(data.tax_cents)}</strong></div>}</div>}{processing&&<State title="Waiting for Stripe verification">You don’t need to pay again. The order will appear here once payment is verified.</State>}{error&&<p className="error" role="alert">{error}</p>}{!paid&&!ended&&!processing&&<button className="button primary full" disabled={busy||!host.hostCapabilities?.openLinks||!host.hostCapabilities?.serverTools} onClick={()=>void launch()}>{busy?'Opening…':'Open secure test checkout ↗'}</button>}<Note>{paid?'Payment is confirmed. Delivery follows the seller’s agreed terms.':'Test mode · no real money charged. A redirect alone never confirms your order.'}</Note></>;
}

function Seller({data,canAsk,ask,busy}:{data:Payload;canAsk:boolean;ask:(s:string)=>Promise<void>;busy:boolean}) {
 return <><div className="intro"><span className="eyebrow">{data.role==='buyer'?'Your negotiation':'Your business'}</span><h1>{data.inventory?'Your inventory.':data.request?.title??'Buyer requests.'}</h1><p>{data.inventory?'Your prices, availability and private minimums.':'Your agent responds within your inventory and pricing rules.'}</p></div>
  <Requirements data={data.request?.requirements}/>{data.inventory?<div className="inventory">{data.inventory.map(i=><div className="inventory-row" key={i.inventory_id}><h2>{i.title}</h2><span>{i.available??0} available</span><dl><div><dt>List price</dt><dd>{money(i.list_cents??0)}</dd></div><div><dt>Private minimum</dt><dd>{money(i.floor_cents??0)}</dd></div></dl></div>)}</div>:data.sessions?<div className="sessions">{data.sessions.length?data.sessions.map(s=><article className="offer" key={s.session_id}><h2>{s.request?.title??'New buying request'}</h2><p>{s.status==='declined'?'Declined':s.turn==='seller'?'Your response is due':'Waiting for buyer'} · round {s.rounds??0}</p>{canAsk&&<button className="button secondary" disabled={busy} onClick={()=>void ask(`Read negotiation ${s.session_id} and my inventory. Explain the buyer's requirements and suggest my next offer within my pricing rules.`)}>Review with my agent</button>}</article>):<State title="No matched requests yet.">New buyer requests appear when they match your inventory and service area.</State>}</div>:<><div className="status-row"><span>{data.turn==='seller'?'Seller’s turn':'Buyer’s turn'}</span><span>Version {data.version??0}</span></div><div className="activity">{data.history?.map((entry,i)=><div className="activity-row" key={i}><strong>{entry.type==='counter'?'Buyer counter':'Seller offer'} {entry.total_cents!==undefined?money(entry.total_cents):''}</strong><span>{entry.note??'Saved negotiation action'}</span></div>)}</div>{canAsk&&data.session_id&&<button className="button primary full" disabled={busy} onClick={()=>void ask(`Re-read negotiation ${data.session_id}. ${data.role==='buyer'?'Negotiate within my existing budget; do not reserve or pay.':'Check my inventory and minimum prices, then respond if it is my turn. Never disclose my private minimums to the buyer.'}`)}>Ask my agent to respond</button>}</>}
  <Note>{data.role==='buyer'?'Your spending limit stays private.':'Buyer budgets are hidden. Your private minimums stay with your business.'}</Note>
 </>;
}
