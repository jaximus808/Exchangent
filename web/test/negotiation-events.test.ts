import test from 'node:test';
import assert from 'node:assert/strict';
import {recordedMoves} from '../lib/negotiation-events.ts';
import type {ConvSession} from '../lib/conversation.ts';
const s:ConvSession={session_id:'s',seller_id:'seller',seller_name:'Shop',status:'open',messages:[{kind:'offer',by:'seller',offer_id:'one',total_cents:20000,at:'2026-10-18T04:00:00Z'}]};
test('initial history, repeated polls and rollback snapshots never animate as new traffic',()=>{
 const initial=recordedMoves([s],null);assert.deepEqual(initial.moves,{});
 assert.deepEqual(recordedMoves([s],initial.seen).moves,{});
 const updated={...s,messages:[...s.messages,{kind:'counter' as const,by:'buyer' as const,counter_id:'counter',at:'2026-10-18T04:01:00Z',total_cents:18000}]};
 const next=recordedMoves([updated],initial.seen);assert.equal(next.moves.s.buyer,true);
 assert.deepEqual(recordedMoves([s],next.seen).moves,{});
 assert.deepEqual(recordedMoves([updated],next.seen).moves,{});
});
test('platform updates do not masquerade as agent messages',()=>{
 const initial=recordedMoves([s],null);
 const updated={...s,messages:[...s.messages,{kind:'declined' as const,by:'platform' as const,at:'2026-10-18T04:02:00Z'}]};
 assert.deepEqual(recordedMoves([updated],initial.seen).moves,{});
});
