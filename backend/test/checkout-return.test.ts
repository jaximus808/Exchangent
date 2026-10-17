import test from 'node:test';
import assert from 'node:assert/strict';
import {checkoutReturn} from '../src/checkout-return.ts';
import type {ServerResponse} from 'node:http';
test('checkout return pages never treat navigation as payment confirmation',()=>{
 for(const path of ['/success','/cancel']) {
  let status=0,headers: Record<string,string>={},html='';
  // Test double: records only what checkoutReturn writes.
  checkoutReturn({writeHead:(s: number,h: Record<string,string>)=>{status=s;headers=h;},end:(b: string)=>{html=b;}} as unknown as Pick<ServerResponse,'writeHead'|'end'>,path);
  assert.equal(status,200);assert.match(headers['Content-Type'],/^text\/html/);
  assert.match(headers['Content-Security-Policy'],/default-src 'none'/);
  assert.match(html,/Check my Exchangent order/);assert.match(html,/does not confirm payment or cancel a reservation/);
  assert.doesNotMatch(html,/<script|<form|Your order is confirmed/);
  assert.match(html,path==='/cancel'?/Checkout paused/:/once Stripe payment has been verified/);
 }
});
