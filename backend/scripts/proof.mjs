import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fromEnv } from '../src/commerce.mjs';
const commerce=fromEnv(); const db=commerce.db;
const local=new URL('../.local/',import.meta.url); await mkdir(local,{recursive:true});
const proofFile=new URL('proof.json',local);
async function insert(table,rows) {
 const {error}=await db.database.from(table).insert(rows);
 if(error) throw new Error(`Fixture ${table}: ${error.message}`);
}
if(process.argv.includes('--status')) {
 const proof=JSON.parse(await readFile(proofFile,'utf8'));
 const result=await commerce.status(process.env.DEMO_BUYER_ID,proof.reservation_id);
 console.log(JSON.stringify(result,null,2));
 if(result.order) {
  const {data:events}=await db.database.from('commerce_payment_events').select('event_id,event_type').eq('session_id',proof.session_id).limit(10);
  const {data:outbox}=await db.database.from('commerce_outbox').select('kind,aggregate_id').eq('aggregate_id',result.order.id).limit(10);
  console.log(JSON.stringify({verified_events:events,confirmation_outbox:outbox},null,2));
 }
} else {
 const buyer=process.env.DEMO_BUYER_ID;
 const {data:actors}=await db.database.from('commerce_actors').select('id').eq('id',buyer).limit(1);
 if(!actors?.length) await insert('commerce_actors',[{id:buyer,label:'Sandbox demo buyer',is_demo:true}]);
 const owner=randomUUID(),seller=randomUUID(),request=randomUUID(),offer=randomUUID();
 const desk=randomUUID(),chair=randomUUID();
 await insert('commerce_actors',[{id:owner,label:'Sandbox demo seller owner',is_demo:true}]);
 await insert('commerce_sellers',[{id:seller,owner_id:owner,name:'Demo Office Supply'}]);
 await insert('commerce_inventory',[
  {id:desk,seller_id:seller,sku:'DEMO-DESK',title:'Demo 48 inch desk',floor_cents:15000,available:1},
  {id:chair,seller_id:seller,sku:'DEMO-CHAIR',title:'Demo ergonomic chair',floor_cents:9000,available:1},
 ]);
 await insert('commerce_requests',[{id:request,buyer_id:buyer,budget_cents:40000}]);
 await insert('commerce_offers',[{id:offer,request_id:request,seller_id:seller,version:1,delivery_cents:2500,tax_cents:0,expires_at:new Date(Date.now()+3600000).toISOString()}]);
 await insert('commerce_offer_items',[
  {offer_id:offer,inventory_id:desk,quantity:1,unit_cents:20000},
  {offer_id:offer,inventory_id:chair,quantity:1,unit_cents:14000},
 ]);
 const key=`proof-${randomUUID()}`;
 const [r,retry]=await Promise.all([commerce.reserve(buyer,offer,key),commerce.reserve(buyer,offer,key)]);
 assert.equal(r.id,retry.id);
 assert.equal(r.total_cents,36500);
 const [checkout,again]=await Promise.all([commerce.checkout(buyer,r.id),commerce.checkout(buyer,r.id)]);
 assert.equal(checkout.session_id,again.session_id);
 const proof={...checkout,offer_id:offer,request_id:request,inventory_ids:[desk,chair],created_at:new Date().toISOString()};
 await writeFile(proofFile,JSON.stringify(proof,null,2),{mode:0o600});
 console.log(JSON.stringify({reservation_id:r.id,total_cents:r.total_cents,session_id:checkout.session_id,url:checkout.url,
  duplicate_reservation_prevented:true,duplicate_checkout_prevented:true},null,2));
}
