import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { Commerce, assertTestKey, validateSession } from '../src/commerce.mjs';
const reservation={id:'reservation-1',stripe_session_id:'cs_test_1',total_cents:36500,currency:'usd'};
const session={id:'cs_test_1',livemode:false,mode:'payment',metadata:{reservation_id:'reservation-1'},
 client_reference_id:'reservation-1',amount_total:36500,currency:'usd',payment_status:'paid',status:'complete'};
test('live keys, modes, price and identity mismatches are rejected',()=>{
 assert.throws(()=>assertTestKey('sk_live_forbidden'));
 assert.doesNotThrow(()=>assertTestKey('rk_test_fixture'));
 assert.doesNotThrow(()=>validateSession(session,reservation));
 for(const patch of [{livemode:true},{amount_total:1},{currency:'eur'},{client_reference_id:'other'},{metadata:{}},{id:'cs_test_other'}])
  assert.throws(()=>validateSession({...session,...patch},reservation));
});
const secret='whsec_unit_test_only';
const stripe=new Stripe('sk_test_fixture');
function setup(state=session) {
 const calls=[];
 const c=new Commerce({stripe:{webhooks:stripe.webhooks,checkout:{sessions:{retrieve:async()=>state}}},
  webhookSecret:secret,db:{},baseUrl:'http://localhost',integrationId:'test'});
 c.row=async()=>reservation;c.rpc=async(name,args)=>{calls.push({name,args});return {confirmed:args.p_paid};};
 return {c,calls};
}
function event(type='checkout.session.completed') {
 return JSON.stringify({id:'evt_test_1',livemode:false,type,data:{object:{id:session.id}}});
}
function signed(raw){return stripe.webhooks.generateTestHeaderString({payload:raw,secret});}
test('invalid webhook signatures cannot mutate the database',async()=>{
 const {c,calls}=setup();await assert.rejects(c.webhook(event(),'invalid'),/invalid_signature/);assert.equal(calls.length,0);
});
test('signed event confirms only after refetching authoritative paid session',async()=>{
 const {c,calls}=setup();const raw=event();await c.webhook(Buffer.from(raw),signed(raw));
 assert.equal(calls[0].args.p_paid,true);assert.equal(calls[0].args.p_release,false);
});
test('completed but unpaid is pending; stock is not released',async()=>{
 const {c,calls}=setup({...session,payment_status:'unpaid'});const raw=event();await c.webhook(raw,signed(raw));
 assert.equal(calls[0].args.p_paid,false);assert.equal(calls[0].args.p_pending,true);assert.equal(calls[0].args.p_release,false);
});
test('old expiry event cannot undo an already paid checkout',async()=>{
 const {c,calls}=setup();const raw=event('checkout.session.expired');await c.webhook(raw,signed(raw));
 assert.equal(calls[0].args.p_paid,true);assert.equal(calls[0].args.p_release,false);
});
test('wrong amounts fail even with a valid signature',async()=>{
 const {c,calls}=setup({...session,amount_total:10});const raw=event();
 await assert.rejects(c.webhook(raw,signed(raw)),/payment_mismatch/);assert.equal(calls.length,0);
});
test('reviewed total is validated and forwarded without changing legacy reservations',async()=>{
 const {c,calls}=setup();
 await c.reserve('buyer','offer','key',36500);
 assert.equal(calls[0].args.p_expected_total,36500);
 await c.reserve('buyer','offer','legacy-key');
 assert.equal(Object.hasOwn(calls[1].args,'p_expected_total'),false);
 for(const total of [null,0,-1,1.5,'36500',2147483648]) assert.throws(()=>c.reserve('buyer','offer','key',total),/invalid_input/);
 assert.equal(calls.length,2);
});
test('receipt uses reserved item snapshots and checks ownership before private reads',async()=>{
 const items=[{title:'Desk',quantity:1,unit_cents:20000},{title:'Chair',quantity:1,unit_cents:14000}];
 const reads=[];
 const c=new Commerce({db:{database:{from(table){reads.push(table);return {select(){return this;},eq(){return table==='commerce_reservation_items'?Promise.resolve({data:items}):this;},limit(){return Promise.resolve({data:[{id:'order',status:'confirmed',total_cents:36500}]});}};}}}});
 c.row=async(table)=>table==='commerce_reservations'?{...reservation,buyer_id:'buyer',offer_id:'offer',seller_id:'seller',status:'consumed'}:table==='commerce_offers'?{delivery_cents:2500,tax_cents:0}:{id:'seller',name:'Demo seller',owner_id:'private'};
 await assert.rejects(c.status('other',reservation.id),/forbidden/);assert.equal(reads.length,0);
 const receipt=await c.status('buyer',reservation.id);
 assert.equal(receipt.subtotal_cents,34000);assert.equal(receipt.delivery_cents,2500);assert.equal(receipt.total_cents,36500);
 assert.deepEqual(receipt.seller,{id:'seller',name:'Demo seller'});assert.deepEqual(receipt.items,items);
 items[0].unit_cents=1;
 await assert.rejects(c.status('buyer',reservation.id),/reservation_pricing_mismatch/);
});
