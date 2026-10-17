import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createClient} from '@insforge/sdk';
import {fromEnv} from '../src/commerce.ts';
import type {ApiError,PaymentResult,Row} from '../src/types.ts';
const commerce=fromEnv();const db=commerce.db;
async function insert(table: string,row: Row|Row[]) {
 const {error}=await db.database.from(table).insert(Array.isArray(row)?row:[row]);
 if(error) throw new Error(error.message);
}
async function fixture({floor=100,price=200,budget=1000,expires=3600000,available=1}={}) {
 const buyer=randomUUID(),seller=randomUUID(),inventory=randomUUID(),request=randomUUID(),offer=randomUUID();
 await insert('commerce_actors',{id:buyer,label:'Integration test',is_demo:true});
 await insert('commerce_sellers',{id:seller,owner_id:buyer,name:'Integration test seller'});
 await insert('commerce_inventory',{id:inventory,seller_id:seller,sku:inventory,title:'Disposable test item',floor_cents:floor,available});
 await insert('commerce_requests',{id:request,buyer_id:buyer,budget_cents:budget});
 await insert('commerce_offers',{id:offer,request_id:request,seller_id:seller,version:1,expires_at:new Date(Date.now()+expires).toISOString()});
 await insert('commerce_offer_items',{offer_id:offer,inventory_id:inventory,quantity:1,unit_cents:price});
 return {buyer,seller,inventory,request,offer};
}
test('real DB rejects other buyers, below-floor, over-budget and expired offers',async()=>{
 const f=await fixture();await assert.rejects(commerce.reserve(randomUUID(),f.offer,randomUUID()),/forbidden/);
 for(const [options,code] of [[{floor:300},'below_floor'],[{budget:100},'budget_exceeded'],[{expires:-1000},'offer_expired']] as const) {
  const x=await fixture(options);await assert.rejects(commerce.reserve(x.buyer,x.offer,randomUUID()),new RegExp(code));
  const i=await commerce.row('commerce_inventory',x.inventory);assert.equal(i.available,1);
 }
});
test('real DB serializes competing requests for the last item',async()=>{
 const f=await fixture(); const request=randomUUID(),offer=randomUUID();
 await insert('commerce_requests',{id:request,buyer_id:f.buyer,budget_cents:1000});
 await insert('commerce_offers',{id:offer,request_id:request,seller_id:f.seller,version:1,expires_at:new Date(Date.now()+3600000).toISOString()});
 await insert('commerce_offer_items',{offer_id:offer,inventory_id:f.inventory,quantity:1,unit_cents:200});
 const results=await Promise.allSettled([commerce.reserve(f.buyer,f.offer,randomUUID()),commerce.reserve(f.buyer,offer,randomUUID())]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.match((results.find(x=>x.status==='rejected') as PromiseRejectedResult).reason.message,/out_of_stock/);
 assert.equal((await commerce.row('commerce_inventory',f.inventory)).available,0);
});
test('bundle failure rolls back all stock changes and the reservation',async()=>{
 const f=await fixture();const missing=randomUUID();
 await insert('commerce_inventory',{id:missing,seller_id:f.seller,sku:missing,title:'Unavailable test item',floor_cents:50,available:0});
 await insert('commerce_offer_items',{offer_id:f.offer,inventory_id:missing,quantity:1,unit_cents:100});
 await assert.rejects(commerce.reserve(f.buyer,f.offer,randomUUID()),/out_of_stock/);
 assert.equal((await commerce.row('commerce_inventory',f.inventory)).available,1);
 assert.equal((await commerce.row('commerce_requests',f.request)).status,'negotiating');
});
test('paid event replay creates no additional order, stock decrement or notification',async()=>{
 const proof: {reservation_id: string; session_id: string; inventory_ids: string[]}=JSON.parse(await readFile(new URL('../.local/proof.json',import.meta.url),'utf8'));
 const before=await commerce.status(process.env.DEMO_BUYER_ID as string,proof.reservation_id);
 assert.equal(before.order?.status,'confirmed','Complete the hosted test checkout before running this test');
 const {data:events,error}=await db.database.from('commerce_payment_events').select('event_id').eq('session_id',proof.session_id).limit(1);
 assert.equal(error,null);
 const event=await commerce.stripe.events.retrieve(events![0].event_id as string);
 const raw=JSON.stringify(event);
 const signature=commerce.stripe.webhooks.generateTestHeaderString({payload:raw,secret:process.env.STRIPE_WEBHOOK_SECRET as string});
 const results=await Promise.all([commerce.webhook(raw,signature),commerce.webhook(raw,signature)]);
 assert.ok(results.every(r=>(r as PaymentResult).duplicate===true));
 const after=await commerce.status(process.env.DEMO_BUYER_ID as string,proof.reservation_id);assert.deepEqual(before,after);
 const {data:outbox}=await db.database.from('commerce_outbox').select('id').eq('aggregate_id',before.order!.id).limit(10);
 assert.equal(outbox!.length,1);
 for(const id of proof.inventory_ids) {const stock=await commerce.row('commerce_inventory',id);assert.equal(stock.sold,1);assert.equal(stock.available,0);}
});
test('anonymous SDK cannot read private tables or execute server RPCs',async()=>{
 assert.ok(process.env.INSFORGE_ANON_KEY,'Set the public anon key to run access checks');
 const anon=createClient({baseUrl:process.env.INSFORGE_URL,anonKey:process.env.INSFORGE_ANON_KEY});
 const read=await anon.database.from('commerce_requests').select('id').limit(1);assert.ok(read.error);
 const call=await anon.database.rpc('commerce_reserve',{p_buyer:randomUUID(),p_offer:randomUUID(),p_key:'unauthorized'});assert.ok(call.error);
});
test('HTTP endpoint rejects missing auth and invalid webhook signature',async()=>{
 const read=await fetch('http://127.0.0.1:8787/api/v1/reservations/'+randomUUID());assert.equal(read.status,401);
 const hook=await fetch('http://127.0.0.1:8787/webhooks/stripe',{method:'POST',body:'{}',headers:{'stripe-signature':'invalid'}});
 assert.equal(hook.status,400);assert.equal(((await hook.json()) as {error: ApiError}).error.code,'invalid_signature');
});
