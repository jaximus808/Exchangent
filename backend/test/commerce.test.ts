import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { Commerce, assertTestKey, validateSession } from '../src/commerce.ts';
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
