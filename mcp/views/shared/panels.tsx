import {useEffect,useRef,useState} from 'react';
import {useCallTool,useHostContext,useOpenExternal,useSendFollowUp,useToolContext} from 'mcp-use/react';
import {checkoutUrl,money,readPayload,type Offer,type Payload} from './data.js';
import {canReview,fitDetails,isExpired,lowestOfferIds,mergeSavedState,offersFor,paymentState,progressFor,readableError} from './presentation.js';
import './style.css';

type Kind='buyer'|'offers'|'seller'|'checkout';
function Note({children}:{children:React.ReactNode}) {return <p className="note">{children}</p>;}
function State({title,children}:{title:string;children:React.ReactNode}) {return <div className="state"><strong>{title}</strong><p>{children}</p></div>;}
function checked(value:unknown) {const data=readPayload(value);if(data.status!=='ok')throw Error(JSON.stringify(data));return data;}

export function Panel({kind}:{kind:Kind}) {
 const context=useToolContext<'get_buy_order'>();
 const input=context.toolInput as {request_id?:string;reservation_id?:string;session_id?:string}|undefined;
 const parsed=context.status==='ready'?parse(context.toolOutput):null;
 const identity=input?.request_id??input?.reservation_id??input?.session_id??parsed?.request_id??parsed?.reservation_id??'';
 return <Workspace key={`${kind}:${identity}`} kind={kind}/>;
}
function Workspace({kind}:{kind:Kind}) {
 const context=useToolContext<'get_buy_order'>(),host=useHostContext();
 const [current,setCurrent]=useState<Payload|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const getBuyer=useCallTool('get_buy_order'),getInventory=useCallTool('get_inventory');
 const getSeller=useCallTool('list_my_requests'),getSession=useCallTool('get_negotiation'),getStatus=useCallTool('get_reservation_status');
 const followUp=useSendFollowUp(),pollBusy=useRef(false);
 const parsed=context.status==='ready'?parse(context.toolOutput):null,data=current??parsed;
 const input=context.toolInput as {request_id?:string;reservation_id?:string;session_id?:string}|undefined;
 const requestId=data?.request_id??input?.request_id;
 const reservationId=data?.reservation_id??data?.reservation?.reservation_id??(data?.sessions?undefined:input?.reservation_id);
 const sessionId=data?.session_id??(!current?input?.session_id:undefined);
 const canCall=host.isAvailable&&!!host.hostCapabilities?.serverTools;
 async function update(silent=false) {
  if(pollBusy.current||!canCall)return;
  pollBusy.current=true;if(!silent)setBusy(true);
  try {
   let result;
   if(reservationId)result=await getStatus.callTool({reservation_id:reservationId});
   else if(kind==='seller'&&sessionId)result=await getSession.callTool({session_id:sessionId});
   else if(kind==='seller'&&data?.inventory)result=await getInventory.callTool({});
   else if(kind==='seller')result=await getSeller.callTool({status:'open'});
   else if(requestId)result=await getBuyer.callTool({request_id:requestId});
   if(result){const next=checked(result.structuredContent);setCurrent(old=>mergeSavedState(old??parsed,next));setError('');}
  }catch(e){setError(readableError(e,'Could not refresh. Your saved request is unchanged.'));}
  finally{pollBusy.current=false;if(!silent)setBusy(false);}
 }
 const updateRef=useRef(update);updateRef.current=update;
 const confirmed=data&&paymentState(data)==='confirmed';
 useEffect(()=>{
  if(!canCall||context.status!=='ready'||data?.status!=='ok'||confirmed)return;
  void updateRef.current(true);
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void updateRef.current(true);},5000);
  const visible=()=>{if(document.visibilityState==='visible')void updateRef.current(true);};
  document.addEventListener('visibilitychange',visible);
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[canCall,context.status,confirmed]);
 async function ask(prompt:string) {setBusy(true);try{await followUp({prompt});setError('');}catch{setError('Type this request in your conversation to continue.');}finally{setBusy(false);}}
 async function navigate(target:'offers'|'inventory'|'requests') {
  if(!canCall)return;setBusy(true);
  try {
   const result=target==='inventory'?await getInventory.callTool({}):target==='requests'?await getSeller.callTool({status:'open'}):requestId?await getBuyer.callTool({request_id:requestId}):null;
   if(!result)throw Error('Ask your assistant to reopen your buying request.');
   setCurrent(checked(result.structuredContent));setError('');
  }catch(e){setError(readableError(e,'Could not load this view.'));}finally{setBusy(false);}
 }
 const canAsk=host.isAvailable&&!!host.hostCapabilities?.message;
 return <section className="exchangent" style={{paddingBottom:Math.max(16,host.safeArea.bottom)}}>
  <header className="panel-header"><span className="brand">⇄ <b>exchangent<span>.</span></b></span><span className="role">{kind==='seller'&&data?.role!=='buyer'?'Business workspace':'Buyer workspace'}</span></header>
  {context.status==='pending'?<State title="Finding your latest details…">Your assistant is checking the saved request.</State>:context.status==='error'?<State title="This view couldn’t load.">{readableError(context.error)}</State>:!data?<State title="These details couldn’t be displayed.">Ask your assistant to refresh the request.</State>:data.status==='error'?<State title={data.error?.code==='forbidden'?'Choose the right account':'Reconnect to Exchangent'}>{kind==='seller'?'Reconnect the connector and choose a business you own. A buyer connection cannot read seller inventory.':readableError(Error(JSON.stringify(data)))}</State>:<>
   {error&&<p className="error" role="alert">{error} <button className="text-button" disabled={busy} onClick={()=>void update()}>Try again</button></p>}
   {kind==='seller'?<Seller data={data} busy={busy} canAsk={canAsk} ask={ask} canCall={canCall} navigate={navigate}/>:<>
    <Progress data={data}/>
    {reservationId||(kind==='checkout'&&!data.sessions)?<Checkout data={data} reservationId={reservationId} onChange={setCurrent} onOffers={requestId?()=>void navigate('offers'):undefined}/>:<Buyer data={data} requestId={requestId} onChange={d=>setCurrent({...d,request_id:requestId})} canAsk={canAsk} ask={ask} busy={busy}/>}
   </>}
   <footer><span aria-live="polite">{busy?'Updating…':confirmed?'Order saved':'Saved · safe to close and reopen'}</span><button className="text-button" disabled={busy||!canCall} onClick={()=>void update()}>Refresh</button></footer>
  </>}
 </section>;
}
function parse(value:unknown):Payload|null {try{return readPayload(value);}catch{return null;}}

function Progress({data}:{data:Payload}) {
 const p=progressFor(data),labels=['Match','Negotiate','Review','Payment'];
 return <div className="progress" aria-label="Purchase progress"><ol>{labels.map((label,i)=><li key={label} aria-current={i===p.step?'step':undefined} className={i<p.step?'complete':''}><span>{i<p.step?'✓':i+1}</span>{label}</li>)}</ol><div role="status"><strong>{p.title}</strong><p>{p.detail}</p></div></div>;
}
function Requirements({data}:{data:Payload['requirements']}) {
 if(!data)return null;
 return <div className="requirements">{data.items?.map((item,i)=><span key={i}>{item.quantity??1} × {item.category}{item.max_width_in?` ≤ ${item.max_width_in}″`:''}{item.ergonomic?' · ergonomic':''}</span>)}{data.region&&<span>{data.region.replaceAll('_',' ')}</span>}{data.deliver_by&&<span>Requested by {data.deliver_by}</span>}{data.notes&&<p>{data.notes}</p>}</div>;
}
function Buyer({data,requestId,onChange,canAsk,ask,busy}:{data:Payload;requestId?:string;onChange:(d:Payload)=>void;canAsk:boolean;ask:(s:string)=>Promise<void>;busy:boolean}) {
 const [selectedId,setSelectedId]=useState<string|null>(null);
 const offers=offersFor(data),lowest=lowestOfferIds(offers,data.budget_cents);
 const sorted=[...offers].sort((a,b)=>Number(!canReview(a,data.budget_cents))-Number(!canReview(b,data.budget_cents))||(a.total_cents??Infinity)-(b.total_cents??Infinity));
 const selected=sorted.find(o=>o.offer_id===selectedId&&canReview(o,data.budget_cents));
 return <><div className="intro"><span className="eyebrow">{offers.length?'Businesses competing for you':'Your buying request'}</span><h1>{data.title??'Better offers. Your final say.'}</h1><p>{data.budget_cents!==undefined?`${money(data.budget_cents)} all-in limit · private to you`:'Compare price, fit and delivery before you decide.'}</p></div>
  <Requirements data={data.requirements}/>
  {!!sorted.length&&<table className="comparison-overview" aria-label="Offer comparison"><thead><tr><th>Business</th><th>Started</th><th>Current total</th></tr></thead><tbody>{sorted.map(o=><tr key={o.offer_id}><th scope="row">{o.seller_name??'Seller'}{lowest.has(o.offer_id)&&<small>Lowest eligible</small>}</th><td>{o.opening_total_cents!==undefined?money(o.opening_total_cents):'—'}</td><td>{o.total_cents!==undefined?money(o.total_cents):'Unavailable'}{isExpired(o)&&<small>Expired</small>}</td></tr>)}</tbody></table>}
  <div className="offers">{sorted.length?sorted.map(offer=>{
   const fits=fitDetails(offer,data.requirements),valid=canReview(offer,data.budget_cents);
   const saving=offer.opening_total_cents!==undefined&&offer.total_cents!==undefined?offer.opening_total_cents-offer.total_cents:0;
   return <article className={`offer${lowest.has(offer.offer_id)?' leading':''}`} key={offer.offer_id}>
    <div className="offer-heading"><div><h2>{offer.seller_name??'Seller offer'}</h2>{lowest.has(offer.offer_id)&&<span className="offer-label">Lowest eligible total</span>}<p>{offer.items?.map(i=>`${i.quantity??1} × ${i.title??i.category??'item'}`).join(' · ')}</p></div><div className="offer-price"><strong className="price">{offer.total_cents!==undefined?money(offer.total_cents):'Total unavailable'}</strong><span>All-in total</span></div></div>
    {offer.opening_total_cents!==undefined&&<div className="price-history"><span>Started at {money(offer.opening_total_cents)}</span><strong>{saving>0?`${money(saving)} lower after negotiation`:saving<0?'Terms changed — review the total':'Opening offer'}</strong></div>}
    {!!fits.length&&<ul className="fit-details" aria-label="Matches your requirements">{fits.map(f=><li key={f}>✓ {f}</li>)}</ul>}
    <div className="offer-terms"><span>Delivery {money(offer.delivery_cents??0)} · tax {money(offer.tax_cents??0)}</span>{offer.delivery_days!==undefined&&<span>Seller delivery estimate: {offer.delivery_days===0?'same day':`${offer.delivery_days} day${offer.delivery_days===1?'':'s'}`}</span>}<span>{isExpired(offer)?'Expired — request a fresh offer':offer.expires_at?`Valid until ${new Date(offer.expires_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:''}</span></div>
    {offer.note&&<p className="seller-note">{offer.note}</p>}
    <button className="button secondary" disabled={!valid} onClick={()=>setSelectedId(offer.offer_id!)}>{isExpired(offer)?'Offer expired':!valid?'Above your limit or unavailable':'Review offer'}</button>
   </article>;
  }):<State title={data.sessions?.length?`${data.sessions.length} businesses matched`:'No offers to compare yet'}>{data.sessions?.length?'Seller agents have your request. Offers will appear here as they respond.':'Ask your assistant to review your requirements and delivery area.'}</State>}</div>
  {selected&&<Purchase key={selected.offer_id} offer={selected} budget={data.budget_cents} onClose={()=>setSelectedId(null)} onChange={onChange}/>}
  {!!data.sessions?.length&&<details className="activity"><summary>Negotiation activity · {data.sessions.length} businesses</summary>{data.sessions.map(s=><div className="activity-row" key={s.session_id}><strong>{s.seller_name}</strong><span>{s.status==='declined'?`Declined${s.decline_reason?`: ${s.decline_reason}`:''}`:s.turn==='seller'?'Waiting for seller response':'Seller response received'}</span>{s.latest_counter&&<small>Your last counter: {money(s.latest_counter.total_cents)}</small>}{s.current_offer?.total_cents!==undefined&&<small>Current offer: {money(s.current_offer.total_cents)} · round {s.rounds??1}</small>}</div>)}</details>}
  {canAsk&&requestId&&<button className="button secondary full" disabled={busy} onClick={()=>void ask(`Review request ${requestId} and negotiate with the matched businesses within my existing requirements and budget. Do not reserve or pay without my approval.`)}>Ask my agent to negotiate</button>}
  <Note>“Lowest eligible total” compares current, unexpired offers within your limit. Confirm delivery timing before paying. Nothing is purchased until you approve and pay in Stripe.</Note>
 </>;
}
function Purchase({offer,budget,onClose,onChange}:{offer:Offer;budget?:number;onClose:()=>void;onChange:(d:Payload)=>void}) {
 const reserve=useCallTool('reserve_offer'),checkout=useCallTool('get_checkout_link'),host=useHostContext();
 const [error,setError]=useState(''),[busy,setBusy]=useState(false),key=useRef(crypto.randomUUID());
 async function approve(){
  if(!canReview(offer,budget)){setError('This offer is no longer available. Refresh and review a current offer.');return;}
  setBusy(true);let held:Payload|undefined;
  try {
   const r=checked((await reserve.callTool({offer_id:offer.offer_id!,expected_total_cents:offer.total_cents,idempotency_key:key.current})).structuredContent);
   const id=r.reservation_id??(typeof r.id==='string'?r.id:undefined);if(!id)throw Error('Your hold could not be recovered. Refresh this request before trying again.');
   held={...r,reservation_id:id,total_cents:offer.total_cents,items:offer.items,delivery_cents:offer.delivery_cents,tax_cents:offer.tax_cents};
   onChange(held);
   const payment=checked((await checkout.callTool({reservation_id:id})).structuredContent);
   if(!checkoutUrl(payment))throw Error('The checkout link could not be verified. Your reservation is saved; try opening checkout again.');
   onChange({...held,...payment});
  }catch(e){const message=readableError(e,'Checkout could not be prepared. Refresh your request before retrying.');if(held)onChange({...held,checkout_error:message});else setError(message);}finally{setBusy(false);}
 }
 return <section className="review" aria-label="Review selected offer"><div className="section-title"><h2>Review your selection</h2><button className="text-button" disabled={busy} onClick={onClose}>Close</button></div><p>{offer.seller_name}</p><dl><div><dt>Items</dt><dd>{money(offer.items?.reduce((n,i)=>n+(i.quantity??1)*(i.unit_cents??0),0)??0)}</dd></div><div><dt>Delivery</dt><dd>{money(offer.delivery_cents??0)}</dd></div><div><dt>Tax</dt><dd>{money(offer.tax_cents??0)}</dd></div><div className="total"><dt>Total</dt><dd>{money(offer.total_cents??0)}</dd></div></dl>{error&&<p role="alert" className="error">{error}</p>}<button className="button primary full" disabled={busy||!host.hostCapabilities?.serverTools||!canReview(offer,budget)} onClick={()=>void approve()}>{busy?'Preparing checkout…':`Reserve for ${money(offer.total_cents??0)} & prepare checkout`}</button><Note>Sandbox only. This holds the goods; you approve payment separately in Stripe.</Note></section>;
}
function Checkout({data,reservationId,onChange,onOffers}:{data:Payload;reservationId?:string;onChange:(d:Payload)=>void;onOffers?:()=>void}) {
 const host=useHostContext(),open=useOpenExternal(),link=useCallTool('get_checkout_link');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 const state=paymentState(data),paid=state==='confirmed',processing=state==='verifying',ended=state==='ended',url=checkoutUrl(data);
 async function launch(){setBusy(true);setError('');try{
  let target=url;
  if(!target){if(!reservationId)throw Error('Ask your assistant to recover your saved reservation.');const p=checked((await link.callTool({reservation_id:reservationId})).structuredContent);target=checkoutUrl(p);onChange({...data,...p,checkout_error:undefined});}
  if(!target)throw Error('No verified test checkout link is available. Your request is saved.');
  await open({url:target});
 }catch(e){setError(readableError(e,'Checkout could not be opened. Your reservation is saved.'));}finally{setBusy(false);}}
 return <><div className="intro"><span className="eyebrow">{paid?'Payment verified':ended?'Reservation ended':processing?'Payment processing':'Your approval required'}</span><h1>{paid?'Your order is confirmed.':ended?'Choose a current offer.':processing?'Payment is processing.':'Your items are reserved.'}</h1><p>{paid?'Your payment is verified and your order is saved.':ended?'This hold can no longer be paid. Refresh the available offers to continue.':processing?'You do not need to pay again. This panel will update when verification finishes.':'Open Stripe to approve payment. If you close it, reopen this request to continue.'}</p></div>
  <div className="receipt"><span>{paid?'Total paid':'Reservation total'}</span>{(data.order?.total_cents??data.total_cents??data.reservation?.total_cents)!==undefined&&<strong>{money((data.order?.total_cents??data.total_cents??data.reservation?.total_cents)!)}</strong>}{paid&&<small>Order {data.order!.id.slice(0,8).toUpperCase()}</small>}</div>
  {data.seller&&<p className="note">Sold by {data.seller.name}</p>}
  {!!data.items?.length&&<div className="receipt-items">{data.items.map((item,i)=><div key={i}><span>{item.quantity??1} × {item.title??'Item'}</span><strong>{money((item.quantity??1)*(item.unit_cents??0))}</strong></div>)}{data.delivery_cents!==undefined&&<div><span>Delivery</span><strong>{money(data.delivery_cents)}</strong></div>}{data.tax_cents!==undefined&&<div><span>Demo tax</span><strong>{money(data.tax_cents)}</strong></div>}</div>}
  {(error||data.checkout_error)&&!paid&&!processing&&<p className="error" role="alert">{error||data.checkout_error}</p>}
  {!paid&&!ended&&!processing&&<button className="button primary full" disabled={busy||!host.hostCapabilities?.openLinks||!host.hostCapabilities?.serverTools} onClick={()=>void launch()}>{busy?'Opening…':'Open secure test checkout ↗'}</button>}
  {(ended||error||data.checkout_error)&&onOffers&&<button className="button secondary full" onClick={onOffers}>{ended?'Return to current offers':'Refresh saved request'}</button>}
  <Note>{paid?'Delivery follows the seller’s agreed terms.':'Test mode · no real money charged. Only verified payment confirms an order.'}</Note>
 </>;
}
function Seller({data,canAsk,ask,busy,canCall,navigate}:{data:Payload;canAsk:boolean;ask:(s:string)=>Promise<void>;busy:boolean;canCall:boolean;navigate:(s:'offers'|'inventory'|'requests')=>Promise<void>}) {
 const buyer=data.role==='buyer';
 return <><div className="intro"><span className="eyebrow">{buyer?'Your negotiation':'Seller access verified'}</span><h1>{data.inventory?'Your inventory.':data.request?.title??'Your business workspace.'}</h1><p>{buyer?'Review the recorded offers and counters.':data.inventory?'Your agent negotiates from these prices. Your minimums stay private.':'New matched requests and saved negotiations live here.'}</p></div>
  {!buyer&&<><nav className="workspace-nav" aria-label="Business views"><button className="button secondary" disabled={busy||!canCall} onClick={()=>void navigate('requests')}>Buyer requests</button><button className="button secondary" disabled={busy||!canCall} onClick={()=>void navigate('inventory')}>Inventory & limits</button></nav><div className="seller-guidance"><strong>Your rules, enforced on every offer.</strong><p>Each item must stay at or above its private minimum. Your agent can negotiate, but cannot take payment or sell unavailable stock. Buyers never see your minimums.</p></div></>}
  <Requirements data={data.request?.requirements}/>
  {data.inventory?<div className="inventory">{data.inventory.length?data.inventory.map(i=><div className="inventory-row" key={i.inventory_id}><h2>{i.title}</h2><span>{i.available===undefined?'Availability unknown':`${i.available} available`}{i.available===0?' · offers blocked until stock is available':''}</span><dl><div><dt>List price</dt><dd>{i.list_cents===undefined?'Not configured':money(i.list_cents)}</dd></div><div><dt>Private minimum</dt><dd>{i.floor_cents===undefined?'Not configured':money(i.floor_cents)}</dd></div></dl></div>):<State title="No inventory connected">Add inventory and private minimums through your business setup before your agent can offer goods.</State>}</div>:data.sessions?<div className="sessions">{data.sessions.length?data.sessions.map(s=><article className="offer" key={s.session_id}><h2>{s.request?.title??'New buying request'}</h2><p>{s.status==='declined'?'Declined':s.turn==='seller'?'Your agent’s response is due':'Waiting for buyer'} · round {s.rounds??0}</p>{canAsk&&<button className="button secondary" disabled={busy} onClick={()=>void ask(`Read negotiation ${s.session_id} and my inventory. Explain the buyer's requirements and suggest my next offer within my pricing rules. Never disclose my private minimums.`)}>Review with my agent</button>}</article>):<State title="Ready for matching buyers">Your business is connected. Requests appear when they match your inventory and service area. You can close this panel and return later.</State>}</div>:<><div className="status-row"><span>{data.turn==='seller'?'Seller’s turn':'Buyer’s turn'}</span><span>Round {data.rounds??0}</span></div><div className="activity">{data.history?.map((entry,i)=><div className="activity-row" key={i}><strong>{entry.type==='counter'?'Buyer counter':'Seller offer'} {entry.total_cents!==undefined?money(entry.total_cents):''}</strong><span>{entry.note??'Saved negotiation action'}</span></div>)}</div>{canAsk&&data.session_id&&<button className="button primary full" disabled={busy} onClick={()=>void ask(`Re-read negotiation ${data.session_id}. ${buyer?'Negotiate within my existing budget; do not reserve or pay.':'Check my inventory and minimum prices, then respond if it is my turn. Never disclose my private minimums to the buyer.'}`)}>Ask my agent to respond</button>}</>}
  <Note>{buyer?'Your spending limit stays private.':'Connected to the wrong business? Reconnect Exchangent and choose a business you own on the consent screen. You can return to this workspace later.'}</Note>
 </>;
}
