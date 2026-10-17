import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutReturn} from '../src/checkout-return.mjs';
test('checkout return pages never treat navigation as payment confirmation',()=>{
 for(const path of ['/success','/cancel']) {
  let status,headers,html;
  checkoutReturn({writeHead:(s,h)=>{status=s;headers=h;},end:s=>{html=s;}},path);
  assert.equal(status,200);assert.match(headers['Content-Type'],/^text\/html/);
  assert.match(headers['Content-Security-Policy'],/default-src 'none'/);
  assert.match(html,/Check my Exchangent order/);assert.match(html,/does not confirm payment or cancel a reservation/);
  assert.doesNotMatch(html,/<script|<form|Your order is confirmed/);
  assert.match(html,path==='/cancel'?/Checkout paused/:/once Stripe payment has been verified/);
 }
});
