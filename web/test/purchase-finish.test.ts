import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedPurchase,stockMoves} from '../lib/purchase-finish.ts';
import type {Conversation} from '../lib/conversation.ts';
import type {OrderStatus,InventoryItem} from '../lib/workspace.ts';
const c:Conversation={request_id:'request',status:'confirmed',sessions:[],reservation:{reservation_id:'r',offer_id:'o',seller_id:'seller',status:'consumed',total_cents:30000}};
const receipt:OrderStatus={request_id:'request',reservation_id:'r',status:'consumed',total_cents:30000,currency:'usd',seller:{id:'seller',name:'Shop'},items:[{title:'Desk',quantity:1,unit_cents:28500}],delivery_cents:1500,tax_cents:0,order:{id:'order',status:'confirmed',total_cents:30000,currency:'usd',created_at:'2026-10-18T04:00:00Z'}};
test('purchase finish requires the matched confirmed receipt, not a checkout return or pending hold',()=>{
 assert.equal(verifiedPurchase(c,receipt)?.quantity,1);
 assert.equal(verifiedPurchase({...c,status:'awaiting_payment'},receipt),null);
 for(const status of ['held','payment_pending','expired','failed'])assert.equal(verifiedPurchase(c,{...receipt,status}),null);
 assert.equal(verifiedPurchase(c,{...receipt,order:null}),null);
});
test('wrong request, reservation, seller, currency, totals and malformed items never celebrate',()=>{
 for(const row of [{...receipt,request_id:'other'},{...receipt,reservation_id:'other'},{...receipt,seller:{id:'other',name:'Other'}},{...receipt,currency:'eur'},{...receipt,total_cents:100},{...receipt,items:[]},{...receipt,items:[{title:'Desk',quantity:-1,unit_cents:28500}]},{...receipt,delivery_cents:0}])assert.equal(verifiedPurchase(c,row),null);
});
const item:InventoryItem={inventory_id:'i',sku:'desk',title:'Desk',category:'desk',list_cents:20000,floor_cents:15000,available:8,sold:0};
test('stock moves report observed owner counts and distinguish reservation from sale',()=>{
 assert.deepEqual(stockMoves(undefined,[item]),[]);
 assert.deepEqual(stockMoves([item],[{...item,available:7}])[0],{id:'i',title:'Desk',beforeAvailable:8,available:7,beforeSold:0,sold:0});
 const paid=stockMoves([{...item,available:7}],[{...item,available:7,sold:1}])[0];
 assert.equal(paid.beforeAvailable,paid.available);assert.equal(paid.beforeSold,0);assert.equal(paid.sold,1);
 assert.deepEqual(stockMoves([item],[item]),[]);
});
test('missing sold counts remain unknown rather than being invented as zero',()=>{
 const missing={...item,sold:undefined};
 const move=stockMoves([missing],[{...missing,available:7}])[0];
 assert.equal(move.beforeSold,null);assert.equal(move.sold,null);
});
