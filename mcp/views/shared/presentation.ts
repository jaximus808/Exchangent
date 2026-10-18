import type {Offer,Payload} from './data.js';

export function readableError(error:unknown,fallback='This action could not be completed. Refresh your saved request before retrying.') {
 const message=error instanceof Error?error.message:'';
 try {
  const data=JSON.parse(message);
  switch(data.error?.code) {
   case 'unauthorized':return 'Your connection expired. Reconnect Exchangent, then reopen this request.';
   case 'forbidden':return 'This connection cannot access these details. Choose the correct buyer account or business.';
   case 'reservation_expired':return 'This hold has ended. Refresh your request to review current offers.';
   case 'payment_pending':return 'Payment is still being verified. You do not need to pay again.';
   case 'stale_offer':case 'price_changed':return 'This offer changed. Refresh your request and review the current price before continuing.';
  }
  return fallback;
 } catch {
  return message&&!message.startsWith('{')?message:fallback;
 }
}

export function offersFor(data:Payload):Offer[] {
 return data.offers??data.sessions?.filter(s=>s.status==='open'&&s.current_offer?.is_current!==false&&s.current_offer)
  .map(s=>({...s.current_offer!,seller_name:s.seller_name,session_id:s.session_id,
   opening_total_cents:s.opening_total_cents,delivery_days:s.seller?.delivery_days}))??[];
}
export function isExpired(offer:Offer,now=Date.now()) {
 return !offer.expires_at||!Number.isFinite(Date.parse(offer.expires_at))||Date.parse(offer.expires_at)<=now;
}
export function canReview(offer:Offer,budget?:number,now=Date.now()) {
 return !!offer.offer_id&&offer.within_budget!==false&&offer.is_current!==false&&!isExpired(offer,now)&&offer.total_cents!==undefined&&
  (budget===undefined||offer.total_cents<=budget);
}
export function lowestOfferIds(offers:Offer[],budget?:number,now=Date.now()) {
 const valid=offers.filter(o=>canReview(o,budget,now));
 const lowest=Math.min(...valid.map(o=>o.total_cents!));
 return new Set(valid.filter(o=>o.total_cents===lowest).map(o=>o.offer_id));
}
export function paymentState(data:Payload) {
 const status=data.reservation_status??data.reservation?.status;
 if(status==='consumed'&&data.order?.status==='confirmed')return 'confirmed';
 if(['expired','failed','cancelled'].includes(status??''))return 'ended';
 if(status==='payment_pending'||status==='consumed'||data.request_status==='confirmed')return 'verifying';
 return 'approval';
}
export function progressFor(data:Payload) {
 const payment=paymentState(data);
 if(payment==='confirmed')return {step:3,title:'Order confirmed',detail:'Payment verified. Your order is saved.'};
 if(payment==='ended')return {step:2,title:'Reservation ended',detail:'Refresh your request to see current offers.'};
 if(payment==='verifying')return {step:3,title:'Verifying payment',detail:'You do not need to pay again.'};
 if(data.reservation_id||data.reservation)return {step:2,title:'Waiting for your approval',detail:'Your items are held. Payment happens in Stripe.'};
 const offers=offersFor(data);
 if(offers.some(o=>canReview(o,data.budget_cents)))return {step:2,title:'Offers ready to review',detail:'Compare the terms. You decide whether to buy.'};
 if(offers.length&&offers.every(o=>isExpired(o)))return {step:1,title:'Offers need refreshing',detail:'These offers expired. Ask your assistant to request current prices.'};
 if(data.sessions?.length)return {step:1,title:'Agents are negotiating',detail:`${data.sessions.length} businesses matched. New offers appear here as they arrive.`};
 if(data.sessions)return {step:0,title:'No matching businesses yet',detail:'Ask your assistant to adjust the requirements or delivery area.'};
 return {step:0,title:'Checking your request',detail:'Looking for the latest saved offers and activity.'};
}

// Describe only attributes supported by the returned inventory, not an AI ranking.
export function fitDetails(offer:Offer,requirements:Payload['requirements']) {
 const details:string[]=[];
 for(const wanted of requirements?.items??[]) {
  const items=offer.items?.filter(i=>i.category===wanted.category)??[];
  if(items.reduce((n,i)=>n+(i.quantity??1),0)<(wanted.quantity??1))continue;
  if(wanted.max_width_in!==undefined&&items.every(i=>typeof i.attributes?.width_in==='number'&&i.attributes.width_in<=wanted.max_width_in!))
   details.push(`Desk fits your ${wanted.max_width_in}″ limit`);
  if(wanted.ergonomic&&items.every(i=>i.attributes?.ergonomic===true))details.push('Ergonomic chair included');
 }
 return details;
}

// A request response replaces checkout state: reservation:null must really clear
// a previous hold, URL and payment state when the user returns to current offers.
export function mergeSavedState(previous:Payload|null,next:Payload):Payload {
 if(next.request_id&&next.sessions)return next;
 return {...previous,...next};
}
