import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { Commerce, CommerceError, assertTestKey, checkoutLineItems, validateSession } from '../src/commerce.ts';
import type { Db } from '../src/types.ts';
// Test doubles implement only what each case touches.
const stub=<T,>(value: unknown)=>value as T;
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
type Call={name: string; args: Record<string, unknown>};
function setup(state=session) {
 const calls: Call[]=[];
 const c=new Commerce({stripe:stub<Stripe>({webhooks:stripe.webhooks,checkout:{sessions:{retrieve:async()=>state}}}),
  webhookSecret:secret,db:stub<Db>({}),baseUrl:'http://localhost',integrationId:'test'});
 c.row=async<T,>()=>reservation as T;c.rpc=async<T,>(name: string,args: Record<string, unknown>)=>{calls.push({name,args});return {confirmed:args.p_paid} as T;};
 return {c,calls};
}
function event(type='checkout.session.completed') {
 return JSON.stringify({id:'evt_test_1',livemode:false,type,data:{object:{id:session.id}}});
}
function signed(raw: string){return stripe.webhooks.generateTestHeaderString({payload:raw,secret});}
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
 const reads: string[]=[];
 const c=new Commerce(stub({db:{database:{from(table: string){reads.push(table);return {select(){return this;},eq(){return table==='commerce_reservation_items'?Promise.resolve({data:items}):this;},limit(){return Promise.resolve({data:[{id:'order',status:'confirmed',total_cents:36500}]});}};}}}}));
 c.row=stub<Commerce['row']>(async(table: string)=>table==='commerce_reservations'?{...reservation,buyer_id:'buyer',offer_id:'offer',seller_id:'seller',status:'consumed'}:table==='commerce_offers'?{delivery_cents:2500,tax_cents:0}:{id:'seller',name:'Demo seller',owner_id:'private'});
 await assert.rejects(c.status('other',reservation.id),/forbidden/);assert.equal(reads.length,0);
 const receipt=await c.status('buyer',reservation.id);
 assert.equal(receipt.subtotal_cents,34000);assert.equal(receipt.delivery_cents,2500);assert.equal(receipt.total_cents,36500);
 assert.deepEqual(receipt.seller,{id:'seller',name:'Demo seller'});assert.deepEqual(receipt.items,items);
 items[0].unit_cents=1;
 await assert.rejects(c.status('buyer',reservation.id),/reservation_pricing_mismatch/);
});
test('checkout lines: one per reserved item, then delivery and tax, adding up to the total',()=>{
 const lines=checkoutLineItems({items:[{title:'Walnut desk 46in',quantity:1,unit_cents:21000},{title:'Mesh chair',quantity:2,unit_cents:7500}],
  delivery_cents:1500,tax_cents:0,seller_name:'Alex Woodworks',total_cents:37500,currency:'usd'});
 assert.deepEqual(lines.map(l=>[l.price_data.product_data.name,l.quantity,l.price_data.unit_amount]),
  [['Walnut desk 46in',1,21000],['Mesh chair',2,7500],['Delivery',1,1500]]);
 assert.ok(lines.every(l=>l.price_data.currency==='usd'&&l.price_data.product_data.description==='Sold by Alex Woodworks via Exchangent'));
 assert.ok(!/demo|fictional/i.test(JSON.stringify(lines)));
 const taxed=checkoutLineItems({items:[{title:'x'.repeat(300),quantity:1,unit_cents:100}],delivery_cents:0,tax_cents:9,seller_name:'S',total_cents:109,currency:'usd'});
 assert.deepEqual(taxed.map(l=>l.price_data.product_data.name.length),[250,3]);
 for(const bad of [{total_cents:37499},{items:[]}]) assert.throws(()=>checkoutLineItems({items:[{title:'Desk',quantity:1,unit_cents:100}],
  delivery_cents:0,tax_cents:0,seller_name:'S',total_cents:100,currency:'usd',...bad}),/reservation_pricing_mismatch/);
});
test('the paid order keeps its PaymentIntent; before migration 0800 the payment still applies without it',async()=>{
 const {c,calls}=setup({...session,payment_intent:'pi_test_1'} as typeof session);
 const raw=event();await c.webhook(raw,signed(raw));
 assert.equal(calls[0].args.p_payment_intent,'pi_test_1');
 const old=setup({...session,payment_intent:{id:'pi_test_2'}} as unknown as typeof session);
 old.c.rpc=async<T,>(name: string,args: Record<string, unknown>)=>{
  old.calls.push({name,args});
  if('p_payment_intent' in args) throw new CommerceError('function public.commerce_apply_payment(p_payment_intent => text) does not exist');
  return {confirmed:true} as T;
 };
 await old.c.webhook(raw,signed(raw));
 assert.deepEqual(old.calls.map(x=>x.args.p_payment_intent),['pi_test_2',undefined]);
 const rule=setup({...session,payment_intent:'pi_test_3'} as typeof session);
 rule.c.rpc=async<T,>(name: string,args: Record<string, unknown>)=>{rule.calls.push({name,args});throw new CommerceError('payment_requires_reconciliation');};
 await assert.rejects(rule.c.webhook(raw,signed(raw)),/payment_requires_reconciliation/);
 assert.equal(rule.calls.length,1,'a real refusal is never retried');
});
