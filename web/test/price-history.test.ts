import test from 'node:test';
import assert from 'node:assert/strict';
import {priceHistory,trendPoints} from '../lib/price-history.ts';
import type {ConvSession} from '../lib/conversation.ts';
const base:ConvSession={session_id:'s',seller_id:'seller',seller_name:'Shop',status:'closed',messages:[]};
test('price history sorts recorded seller offers and never charts buyer counters as accepted prices',()=>{
 const history=priceHistory({...base,messages:[
 {kind:'offer',by:'seller',total_cents:30000,at:'2026-10-18T04:00:00Z'},
 {kind:'counter',by:'buyer',total_cents:100,at:'2026-10-18T03:30:00Z'},
 {kind:'offer',by:'buyer',total_cents:50,at:'2026-10-18T03:31:00Z'},
 {kind:'offer',by:'seller',total_cents:46500,at:'2026-10-18T03:00:00Z'},
 {kind:'offer',by:'seller',total_cents:NaN,at:'2026-10-18T04:30:00Z'},
 {kind:'offer',by:'seller',total_cents:20000,at:'invalid'}]});
 assert.deepEqual(history.map(p=>p.cents),[46500,30000]);
});
test('charts safely handle no prices, a single price and unchanged prices',()=>{
 assert.deepEqual(trendPoints([]),[]);
 assert.equal(trendPoints([100]).length,1);
 assert.ok(trendPoints([0,0]).every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 assert.equal(trendPoints([100,100])[0].y,trendPoints([100,100])[1].y);
});
test('common zero-based domain shows larger concessions as larger movements',()=>{
 const small=trendPoints([46500,44300],100,28,[0,53000]);
 const large=trendPoints([46500,30000],100,28,[0,53000]);
 assert.ok(large[1].y-large[0].y>small[1].y-small[0].y);
 assert.equal(large[0].y,small[0].y);
});
