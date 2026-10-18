import test from 'node:test';
import assert from 'node:assert/strict';
import {readPayload,type Offer} from '../views/shared/data.ts';
import {canReview,fitDetails,lowestOfferIds,mergeSavedState,offersFor,paymentState,progressFor,readableError} from '../views/shared/presentation.ts';

const now=Date.parse('2026-10-18T01:00:00Z');
const offer:Offer={offer_id:'offer',is_current:true,total_cents:36000,opening_total_cents:46500,expires_at:'2026-10-18T02:00:00Z'};
test('lowest eligible total excludes expired, superseded, above-budget and malformed offers; ties are explicit',()=>{
 const offers=[offer,{...offer,offer_id:'expired',total_cents:1,expires_at:'2026-10-18T00:00:00Z'},
  {...offer,offer_id:'stale',total_cents:2,is_current:false},{...offer,offer_id:'over',total_cents:50000},
  {...offer,offer_id:'missing',total_cents:3,expires_at:undefined},{...offer,offer_id:'tie'}];
 assert.deepEqual([...lowestOfferIds(offers,40000,now)],['offer','tie']);
 assert.equal(canReview(offer,40000,Date.parse(offer.expires_at!)),false);
 assert.equal(canReview({...offer,total_cents:undefined},40000,now),false);
 assert.equal(canReview({...offer,within_budget:false},undefined,now),false);
});
test('serialized tool errors show recovery instructions rather than JSON',()=>{
 assert.equal(readableError(new Error(JSON.stringify({status:'error',error:{code:'reservation_expired'},next:'Call a tool.'}))),'This hold has ended. Refresh your request to review current offers.');
 assert.equal(readableError(new Error('{broken'), 'Try again.'),'Try again.');
});
test('payment confirmation needs both authoritative states; consumed without an order keeps verifying',()=>{
 const data=readPayload({status:'ok',reservation_status:'consumed',order:null});
 assert.equal(paymentState(data),'verifying');
 assert.equal(paymentState({...data,order:{id:'order',status:'confirmed',total_cents:36000}}),'confirmed');
 assert.equal(paymentState({...data,reservation_status:'held',order:{id:'order',status:'confirmed',total_cents:36000}}),'approval');
 for(const state of ['failed','expired','cancelled'])assert.equal(paymentState({...data,reservation_status:state}),'ended');
 assert.equal(paymentState({...data,reservation_status:'payment_pending'}),'verifying');
});
test('returning to current offers clears a stale checkout and hold; reopen pending/confirmed request stays verifiable',()=>{
 const previous=readPayload({status:'ok',reservation_id:'old',checkout_url:'https://checkout.stripe.com/pay',reservation_status:'failed'});
 const request=readPayload({status:'ok',request_id:'request',sessions:[],reservation:null});
 assert.deepEqual(mergeSavedState(previous,request),request);
 assert.equal(paymentState(readPayload({status:'ok',request_status:'confirmed',reservation:{reservation_id:'saved',status:'consumed'}})),'verifying');
 assert.equal(progressFor({...previous,reservation_status:'payment_pending'}).title,'Verifying payment');
});
test('comparison uses recorded opening total and seller delivery policy, never invents a price or a fit',()=>{
 const data=readPayload({status:'ok',sessions:[{session_id:'s',status:'open',seller_name:'Bay Desk Co',opening_total_cents:46500,seller:{delivery_days:2},current_offer:offer}]});
 assert.equal(offersFor(data)[0].opening_total_cents,46500);
 assert.equal(offersFor(data)[0].delivery_days,2);
 const requirements={items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
 assert.deepEqual(fitDetails({...offer,items:[{category:'desk',attributes:{width_in:46}},{category:'chair',attributes:{ergonomic:true}}]},requirements),['Desk fits your 48″ limit','Ergonomic chair included']);
 assert.deepEqual(fitDetails({...offer,items:[{category:'desk'},{category:'chair',attributes:{ergonomic:false}}]},requirements),[]);
});

test('an expired request says so instead of "agents are negotiating"', async () => {
 const {progressFor}=await import('../views/shared/presentation.ts');
 const p=progressFor({status:'ok',request_status:'expired',sessions:[{session_id:'s1',status:'closed'}]} as never);
 assert.equal(p.title,'Request expired');
});
