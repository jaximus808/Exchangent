import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutUrl,readPayload} from '../views/shared/data.ts';
test('a held reservation accepts nullable checkout fields before a session exists',()=>{
 const data=readPayload({status:'ok',id:'reservation',checkout_url:null,checkout_session_id:null,reservation_status:'held',total_cents:36000});
 assert.equal(data.total_cents,36000);assert.equal(checkoutUrl(data),null);
});
test('checkout navigation requires an HTTPS Stripe URL and a test session',()=>{
 const base={status:'ok' as const,checkout_session_id:'cs_test_example'};
 for(const checkout_url of ['http://checkout.stripe.com/pay','https://checkout.stripe.com.evil.example/pay','javascript:alert(1)'])
  assert.equal(checkoutUrl({...base,checkout_url}),null);
 assert.equal(checkoutUrl({...base,checkout_url:'https://checkout.stripe.com/c/pay/cs_test_example'}),'https://checkout.stripe.com/c/pay/cs_test_example');
 assert.equal(checkoutUrl({...base,checkout_session_id:'cs_live_example',checkout_url:'https://checkout.stripe.com/pay'}),null);
});
test('malformed totals do not render as trustworthy prices',()=>{
 assert.throws(()=>readPayload({status:'ok',total_cents:'36000'}),/saved details/);
 assert.throws(()=>readPayload({status:'ok',total_cents:-1}),/saved details/);
});
import {bestOffer,hopLine,readConversation,speaker} from '../views/shared/conversation-data.ts';
test('conversation: best open offer, speakers, Inkbox hop lines',()=>{
 const data=readConversation({status:'ok',request_id:'r',request_status:'negotiating',delegate_negotiation:true,sessions:[
  {session_id:'a',seller_name:'Alex Woodworks',status:'open',seller_agent:true,messages:[{kind:'offer',by:'seller',total_cents:46500},{kind:'counter',by:'buyer',total_cents:30000},{kind:'offer',by:'seller',total_cents:30000,delivery:{transport:'inkbox',from_handle:'exchangent-alex-woodworks',to_handle:'exchangent-buyer',message_id:'1234567890ab'}}]},
  {session_id:'b',seller_name:'Bay Desk Co',status:'open',seller_agent:false,messages:[{kind:'offer',by:'seller',total_cents:44300}]},
  {session_id:'c',seller_name:'Gone',status:'declined',messages:[{kind:'offer',by:'seller',total_cents:100}]},
 ]});
 assert.deepEqual(bestOffer(data),{seller:'Alex Woodworks',total:30000});
 const [a,b]=data.sessions!;
 assert.equal(speaker(a.messages![1],a,true),'Your agent');
 assert.equal(speaker(a.messages![1],a,false),'You');
 assert.equal(speaker(a.messages![0],a,true),'Alex Woodworks agent');
 assert.equal(speaker(b.messages![0],b,true),'Bay Desk Co');
 assert.equal(hopLine(a.messages![2]),'Inkbox A2A · exchangent-alex-woodworks → exchangent-buyer · 12345678');
 assert.equal(hopLine(a.messages![1]),'Delivery pending');
 assert.equal(hopLine({kind:'offer',by:'seller',delivery:{transport:'local'}}),'Delivered in-process');
 assert.throws(()=>readConversation({sessions:'nope'}),/could not be displayed/);
});

test("readPayload: a seller negotiation's seller settings (no id or name) still parse", () => {
  const data = readPayload({ status: "ok", session_id: "s1", seller: { service_area: "san_francisco", delivery_days: 1, delivery_cents: 1500 }, history: [] });
  assert.equal(data.session_id, "s1");
});

test('resolution panel helpers: remedy wording, case labels and a simulated delivery timeline', async () => {
 const {remedyLabel,caseTypeLabel,timeline,readResolution}=await import('../views/shared/resolution-data.ts');
 assert.equal(remedyLabel({kind:'keep_with_discount',amount_cents:6000}),'Keep it with $60.00 back');
 assert.equal(remedyLabel({kind:'return_for_refund',return_shipping_paid_by:'seller'}),'Return for a refund (seller pays return shipping)');
 assert.equal(remedyLabel({kind:'something_new'}),'something new');
 assert.equal(caseTypeLabel('substitution'),'Out of stock · substitute offered');
 const data=readResolution({status:'ok',order_status:'delivered',created_at:'2026-10-18T04:00:00Z',shipped_at:'2026-10-18T04:30:00Z',carrier:'UPS',tracking:'1Z',delivered_at:'2026-10-18T04:45:00Z',delivery_evidence:{source:'simulated'}});
 const steps=timeline(data);
 assert.deepEqual(steps.map(s=>s.done),[true,true,true,false]);
 assert.equal(steps[2].detail,'Simulated carrier scan (test mode)');
 assert.equal(steps[1].detail,'UPS · 1Z');
 assert.throws(()=>readResolution({status:'nope'}));
});
