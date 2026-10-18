import test from 'node:test';
import assert from 'node:assert/strict';
import {orderLink,selectedSeller,sellerOffer,watchState,watchAccess} from '../lib/watch-view.ts';
import {bestOffer,agreedDeal} from '../lib/conversation.ts';
import type {ConvSession,Conversation} from '../lib/conversation.ts';
const now=Date.parse('2026-10-18T04:00:00Z');
const session:ConvSession={session_id:'session',seller_id:'seller',seller_name:'Store',status:'open',messages:[
 {kind:'offer',by:'seller',at:'2026-10-18T03:00:00Z',offer_id:'first',total_cents:46500},
 {kind:'offer',by:'seller',at:'2026-10-18T03:05:00Z',offer_id:'offer',total_cents:30000}],
 current_offer:{offer_id:'offer',total_cents:30000,expires_at:'2026-10-18T05:00:00Z'}};
const conversation:Conversation={request_id:'request',status:'negotiating',sessions:[session]};
test('comparison uses saved opening price, excludes expired and closed offers from eligibility',()=>{
 assert.deepEqual(sellerOffer(session,now),{opening:46500,total:30000,eligible:true,expired:false});
 assert.equal(sellerOffer(session,Date.parse(session.current_offer!.expires_at)).eligible,false);
 assert.equal(sellerOffer({...session,status:'declined'},now).eligible,false);
 assert.equal(sellerOffer({...session,current_offer:undefined},now).eligible,false);
});
test('paid seller is resolved from the reservation rather than the cheapest current offer',()=>{
 const cheaper={...session,session_id:'cheap',seller_id:'cheap-seller',current_offer:{...session.current_offer!,total_cents:10000},messages:[]};
 assert.equal(selectedSeller({...conversation,sessions:[cheaper,session],reservation:{reservation_id:'r',offer_id:'offer',seller_id:'seller',status:'consumed',total_cents:30000}})?.seller_id,'seller');
 assert.equal(selectedSeller(conversation),null);
});
test('pending payments stay in verification and confirmation requires consumed reservation',()=>{
 assert.equal(watchState({...conversation,status:'confirmed'}).kind,'verifying');
 const reservation={reservation_id:'r',offer_id:'offer',status:'payment_pending',total_cents:30000};
 assert.equal(watchState({...conversation,status:'awaiting_payment',reservation}).kind,'verifying');
 assert.equal(watchState({...conversation,status:'confirmed',reservation:{...reservation,status:'consumed'}}).kind,'confirmed');
 assert.equal(watchState(null).kind,'loading');
 assert.equal(watchState({...conversation,sessions:[]}).label,'No matching sellers');
 assert.equal(watchState({...conversation,sessions:[]}).live,false);
});
test('view order links open the same request in the buying workspace',()=>{
 assert.equal(orderLink('request'), '/?request=request#buying');
});
test('accepted counter requests review only while the actual current offer is unexpired',()=>{
 const accepted={...session,messages:[session.messages[0],{kind:'counter' as const,by:'buyer' as const,at:'2026-10-18T03:04:00Z',total_cents:30000},session.messages[1]]};
 assert.equal(watchState({...conversation,sessions:[accepted]},now).kind,'review');
 assert.equal(watchState({...conversation,sessions:[accepted]},Date.parse(session.current_offer!.expires_at)).kind,'negotiating');
});
test('expired holds do not appear selected or ask for payment approval',()=>{
 const c={...conversation,status:'awaiting_payment',reservation:{reservation_id:'expired',offer_id:'offer',seller_id:'seller',status:'expired',total_cents:30000}};
 assert.equal(selectedSeller(c),null);
 assert.equal(watchState(c,now).kind,'ended');
 assert.equal(watchState(c,now).label,'Reservation expired');
});

test('access failures distinguish sign-in, ownership and missing requests',()=>{
 assert.equal(watchAccess(401),'signed_out');
 assert.equal(watchAccess(403),'not_yours');
 assert.equal(watchAccess(404),'not_found');
 assert.equal(watchAccess(503),null);
});

test('closed or declined sellers do not look like a running negotiation',()=>{
 const state=watchState({...conversation,sessions:[{...session,status:'closed'}]},now);
 assert.equal(state.label,'No active sellers');assert.equal(state.live,false);
 assert.equal(watchState({...conversation,status:'awaiting_payment',reservation:{reservation_id:'r',offer_id:'offer',status:'released',total_cents:30000}},now).kind,'ended');
});

test('dashboard best/deal summaries exclude expired or unbound historical offers',()=>{
 assert.equal(bestOffer(conversation,now)?.offer.offer_id,'offer');
 const later=Date.parse(session.current_offer!.expires_at);
 assert.equal(bestOffer(conversation,later),null);
 assert.equal(bestOffer({...conversation,sessions:[{...session,current_offer:null}]},now),null);
 const met={...session,messages:[session.messages[0],{kind:'counter' as const,by:'buyer' as const,at:'2026-10-18T03:04:00Z',total_cents:30000},session.messages[1]]};
 assert.ok(agreedDeal({...conversation,sessions:[met]},now));
 assert.equal(agreedDeal({...conversation,sessions:[met]},later),null);
});
