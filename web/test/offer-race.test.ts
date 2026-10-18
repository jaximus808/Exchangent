import test from 'node:test';
import assert from 'node:assert/strict';
import {offerRace} from '../lib/offer-race.ts';
import type {ConvSession} from '../lib/conversation.ts';
function seller(id:string,prices:number[]):ConvSession{return {session_id:id,seller_id:id,seller_name:id,status:'open',messages:prices.map((cents,i)=>({kind:'offer',by:'seller',offer_id:`${id}-${i}`,total_cents:cents,at:new Date(Date.UTC(2026,9,18,4,i)).toISOString()}))};}
test('all sellers use the same price scale and seller offer sequence',()=>{
 const result=offerRace([seller('a',[46500,30000]),seller('b',[46500,44300,40000])],500);
 const [a,b]=result.series;
 assert.equal(a.points[0].y,b.points[0].y);
 assert.equal(a.points[1].x,b.points[1].x);
 assert.ok(a.points[1].y>b.points[1].y);
 assert.equal(result.rounds,3);assert.ok(result.ceiling>=46500);
});
test('empty, zero-value, single-offer and identical-price charts have finite coordinates',()=>{
 for(const sessions of [[],[seller('a',[0])],[seller('a',[1])],[seller('a',[30000,30000])]]){
  const result=offerRace(sessions,300);
  assert.ok(result.ceiling>0);
  for(const s of result.series)for(const p of s.points)assert.ok(Number.isFinite(p.x)&&Number.isFinite(p.y));
 }
});
test('buyer counters are excluded and closed sellers retain historical prices',()=>{
 const s=seller('a',[46500,30000]);s.status='closed';s.messages.splice(1,0,{kind:'counter',by:'buyer',total_cents:1,at:'2026-10-18T04:00:30Z'});
 assert.deepEqual(offerRace([s]).series[0].points.map(p=>p.cents),[46500,30000]);
});
