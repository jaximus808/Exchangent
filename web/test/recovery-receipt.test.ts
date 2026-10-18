import test from 'node:test';
import assert from 'node:assert/strict';
import {checkpoint,restoreNotice,eventKeys} from '../lib/recovery.ts';
import {activityReceipt} from '../lib/activity-receipt.ts';
import type {Conversation,ConvSession} from '../lib/conversation.ts';
const now=Date.parse('2026-10-18T04:00:00Z');
const s:ConvSession={session_id:'s',seller_id:'seller',seller_name:'Shop',status:'open',current_offer:{offer_id:'o2',total_cents:30000,expires_at:'2026-10-18T05:00:00Z'},messages:[{kind:'offer',by:'seller',offer_id:'o1',total_cents:46500,at:'2026-10-18T03:00:00Z'},{kind:'counter',by:'buyer',counter_id:'c1',total_cents:30000,at:'2026-10-18T03:01:00Z'},{kind:'offer',by:'seller',offer_id:'o2',total_cents:30000,at:'2026-10-18T03:02:00Z',delivery:{transport:'inkbox',message_id:'msg'}}]};
const c:Conversation={request_id:'request',status:'negotiating',sessions:[s]};
test('reopened views compare saved event IDs and do not replay existing moves',()=>{
 const before={...c,sessions:[{...s,messages:s.messages.slice(0,1)}]};
 const saved=checkpoint(before,'buyer',now)!;
 assert.equal(restoreNotice(JSON.stringify(saved),c,'buyer',now)?.newMoves,2);
 assert.equal(restoreNotice(JSON.stringify(checkpoint(c,'buyer',now)),c,'buyer',now)?.newMoves,0);
 assert.equal(eventKeys({...c,sessions:[{...s,messages:[...s.messages,s.messages[2]]}]}).length,3);
});
test('missing, corrupted, stale and other-account checkpoints do not affect server recovery',()=>{
 const saved=checkpoint(c,'buyer',now)!;
 for(const raw of [null,'bad',JSON.stringify({...saved,actor:'other'}),JSON.stringify({...saved,request:'other'}),JSON.stringify({...saved,at:now-8*86400000})])assert.equal(restoreNotice(raw,c,'buyer',now),null);
 assert.ok(!JSON.stringify(saved).includes('46500')); // no prices, notes or private policy data in checkpoint
});
test('activity facts dedupe offers, count actual contact evidence and compare the same seller',()=>{
 const empty={...s,session_id:'uncontacted',seller_id:'uncontacted',messages:[]};
 const facts=activityReceipt({...c,sessions:[{...s,messages:[...s.messages,s.messages[2]]},empty]},null,now);
 assert.equal(facts.contacts,1);assert.equal(facts.offers,2);assert.equal(facts.counters,1);assert.equal(facts.moves,3);assert.equal(facts.deliveries,1);assert.equal(facts.reduction,16500);assert.equal(facts.payment,'Not started');
});
test('payment is never verified from a consumed flag alone; expired prices do not claim savings',()=>{
 assert.equal(activityReceipt({...c,status:'confirmed',reservation:{reservation_id:'r',offer_id:'o2',status:'consumed',total_cents:30000}},null,now).payment,'Verifying');
 assert.equal(activityReceipt(c,null,Date.parse('2026-10-18T06:00:00Z')).reduction,null);
});
