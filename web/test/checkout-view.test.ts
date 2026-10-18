import test from 'node:test';import assert from 'node:assert/strict';
import {checkoutState,savedReservationId} from '../lib/checkout-view.ts';
import type {Conversation} from '../lib/conversation.ts';import type {OrderStatus} from '../lib/workspace.ts';
const conv:Conversation={request_id:'this-request',status:'awaiting_payment',sessions:[],reservation:{reservation_id:'this-hold',offer_id:'offer',status:'held',total_cents:30000}};
const receipt:OrderStatus={request_id:'other-request',reservation_id:'other-hold',status:'held',total_cents:30000,currency:'usd',order:null};
test('checkout recovers the current request from server state without browser storage',()=>{
 assert.equal(savedReservationId('this-request',conv), 'this-hold');
 assert.equal(savedReservationId('this-request',null,receipt),null);
 assert.equal(savedReservationId('other-request',conv,receipt),'other-hold');
 assert.equal(savedReservationId('this-request',{...conv,reservation:null},{...receipt,request_id:'this-request',status:'expired'}),null);
});
test('pending and incomplete confirmation suppress payment until authoritative confirmation',()=>{
 assert.equal(checkoutState('awaiting_payment',{...receipt,status:'payment_pending'}),'verifying');
 assert.equal(checkoutState('awaiting_payment',null,{...conv,reservation:{...conv.reservation!,status:'payment_pending'}}),'verifying');
 assert.equal(checkoutState('confirmed',null),'verifying');
 assert.equal(checkoutState('confirmed',{...receipt,status:'consumed',order:{id:'order',status:'confirmed',total_cents:30000,currency:'usd',created_at:new Date().toISOString()}}),'confirmed');
 assert.equal(checkoutState('awaiting_payment',{...receipt,status:'failed'}),'ended');
});

test('ended holds and reversed paid orders never invite another payment',()=>{
 assert.equal(checkoutState('awaiting_payment',{...receipt,status:'released'}),'ended');
 for(const status of ['refunded','cancelled'])assert.equal(checkoutState('confirmed',{...receipt,status:'consumed',order:{id:'o',status,total_cents:30000,currency:'usd',created_at:'2026-10-18T04:00:00Z'}}),'reversed');
});
