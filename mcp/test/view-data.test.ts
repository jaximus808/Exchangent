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
