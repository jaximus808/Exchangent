// Real-database checks for the negotiation migration. Run with `npm run test:db`
// (throwaway Docker postgres:16; see run.sh). Exercises the RPCs through the real HTTP
// handler, using a pg-backed stand-in for the InsForge admin client.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pgDb } from '../../scripts/pg-db.mjs';
import { seed, seedId } from '../../scripts/seed-negotiation.mjs';
import { Commerce } from '../../src/commerce.mjs';
import { Negotiation } from '../../src/negotiation.mjs';
import { createHandler } from '../../src/http.mjs';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const db=pgDb(process.env.DATABASE_URL);
const sql=async(text,params)=>(await db.pool.query(text,params)).rows;
const LEGACY='legacy-demo-token-for-tests';
let server,base,P,bay,mission,soma;
before(async()=>{
 P=await seed(db);
 [bay,mission,soma]=P.sellers;
 const commerce=new Commerce({db,stripe:{},webhookSecret:'whsec_unused',baseUrl:'http://127.0.0.1',integrationId:'test'});
 const negotiation=new Negotiation({db,demoToken:LEGACY,demoBuyerId:P.buyer.actor_id});
 server=createServer(createHandler({commerce,negotiation}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server?.close();await db.end();});
async function call(method,path,token,body,key) {
 const headers={};
 if(token) headers.authorization=`Bearer ${token}`;
 if(key) headers['idempotency-key']=key;
 if(body!==undefined) headers['content-type']='application/json';
 const res=await fetch(base+'/api/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json()};
}
const ok=r=>{assert.ok(r.body.data!==undefined,JSON.stringify(r.body));return r.body.data;};
const err=(r,code,status)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));if(status) assert.equal(r.status,status);
 assert.ok(r.body.error.next_action);};
const inv=(seller,sku)=>seedId(`inventory:${SLUG[seller]}:${sku}`);
const SLUG={};
const has=(v,k)=>JSON.stringify(v).includes(`"${k}"`);
const requirements={region:'san_francisco',deliver_by:'2026-10-18',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
const order={title:'Desk and ergonomic chair',requirements,budget_cents:40000,target_cents:36000};

test('full negotiation loop through HTTP on real Postgres',async t=>{
 Object.assign(SLUG,{[bay.seller_id]:'bay-desk-co',[mission.seller_id]:'mission-ergonomics',[soma.seller_id]:'soma-office-supply'});
 const buyer=P.buyer.token;let request,bs,ms,offer1,offer2,counter;

 await t.test('auth, scopes and idempotency key',async()=>{
  err(await call('GET','/me'),'unauthorized',401);
  err(await call('GET','/me','x'.repeat(64)),'unauthorized',401);
  assert.equal(ok(await call('GET','/me',bay.token)).seller_id,bay.seller_id);
  err(await call('POST','/buy-requests',bay.token,order,'k'),'forbidden',403);
  err(await call('POST','/buy-requests',buyer,order),'idempotency_key_required',400);
  err(await call('GET','/worker/events',buyer),'forbidden',403);
  err(await call('POST','/buy-requests',buyer,{...order,budget_cents:'400'},'bad'),'invalid_input',400);
 });

 await t.test('create request matches sellers; wide-desk seller excluded; idempotent',async()=>{
  const key=randomUUID();
  const [a,b]=await Promise.all([call('POST','/buy-requests',buyer,order,key),call('POST','/buy-requests',buyer,order,key)]);
  request=ok(a);assert.deepEqual(ok(b),request);
  assert.equal(request.status,'negotiating');
  assert.deepEqual(request.sessions.map(s=>s.seller_name),['Bay Desk Co','Mission Ergonomics']);
  bs=request.sessions[0].session_id;ms=request.sessions[1].session_id;
  err(await call('POST','/buy-requests',buyer,{...order,budget_cents:50000},key),'idempotency_conflict',409);
  const [{count}]=await sql('SELECT count(*)::int AS count FROM commerce_requests WHERE idempotency_key=$1',[key]);
  assert.equal(count,1);
  // Without the width limit SoMa matches too.
  const wide=ok(await call('POST','/buy-requests',buyer,{...order,requirements:{...requirements,items:[{category:'desk'},{category:'chair',ergonomic:true}]}},randomUUID()));
  assert.equal(wide.sessions.length,3);
  const none=ok(await call('POST','/buy-requests',buyer,{...order,requirements:{region:'oakland',items:[{category:'desk'}]}},randomUUID()));
  assert.equal(none.sessions.length,0);
 });

 await t.test('seller reads are redacted; other sellers are forbidden',async()=>{
  const list=ok(await call('GET','/seller/sessions?status=open',bay.token));
  const s=list.find(x=>x.session_id===bs);
  assert.equal(s.turn,'seller');assert.equal(s.version,0);assert.equal(s.request.title,order.title);
  assert.deepEqual(s.request.requirements,requirements);
  assert.ok(!has(list,'budget_cents')&&!has(list,'target_cents'));
  const stock=ok(await call('GET','/seller/inventory',bay.token));
  assert.equal(stock.length,3);assert.ok(stock.every(i=>i.floor_cents&&i.list_cents&&i.category));
  const view=ok(await call('GET',`/sessions/${bs}`,bay.token));
  assert.equal(view.role,'seller');assert.ok(!has(view,'budget_cents')&&!has(view,'target_cents'));
  err(await call('GET',`/sessions/${bs}`,mission.token),'forbidden',403);
  err(await call('POST',`/sessions/${bs}/offers`,mission.token,{expected_version:0,items:[]},'m1'),'invalid_input',400);
  err(await call('POST',`/sessions/${bs}/offers`,mission.token,
   {expected_version:0,items:[{inventory_id:inv(mission.seller_id,'MIS-DESK-48'),quantity:1,unit_cents:30000}]},'m1'),'forbidden',403);
 });

 const lines=(desk,chair,deskSku='BAY-DESK-46')=>[{inventory_id:inv(bay.seller_id,deskSku),quantity:1,unit_cents:desk},
  {inventory_id:inv(bay.seller_id,'BAY-CHAIR-MESH'),quantity:1,unit_cents:chair}];

 await t.test('seller offer validation: floor, stock, ownership, requirements',async()=>{
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:0,items:lines(18000,18000)},randomUUID()),'below_floor',409);
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:0,items:[{...lines(26000,18000)[0],quantity:4},lines(26000,18000)[1]]},randomUUID()),'out_of_stock',409);
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:0,items:lines(42000,18000,'BAY-DESK-60')},randomUUID()),'requirements_mismatch',409);
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:0,items:[lines(26000,18000)[0]]},randomUUID()),'requirements_mismatch',409);
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:0,items:[...lines(26000,18000),
   {inventory_id:inv(mission.seller_id,'MIS-CHAIR-PRO'),quantity:1,unit_cents:21000}]},randomUUID()),'invalid_input',400);
  const [{count}]=await sql('SELECT count(*)::int AS count FROM commerce_offers WHERE session_id=$1',[bs]);
  assert.equal(count,0);
 });

 await t.test('valid offer, idempotent replay, stale and wrong-turn rejected',async()=>{
  const key=randomUUID(),body={expected_version:0,items:lines(26000,18000),note:'List price, delivered tomorrow.'};
  const [a,b]=await Promise.all([call('POST',`/sessions/${bs}/offers`,bay.token,body,key),call('POST',`/sessions/${bs}/offers`,bay.token,body,key)]);
  offer1=ok(a);assert.deepEqual(ok(b),offer1);
  assert.deepEqual({version:offer1.version,total_cents:offer1.total_cents,session_version:offer1.session_version},{version:1,total_cents:46500,session_version:1});
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{...body,delivery_cents:0},key),'idempotency_conflict',409);
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,body,randomUUID()),'stale_offer',409);
  err(await call('POST',`/sessions/${bs}/offers`,bay.token,{...body,expected_version:1},randomUUID()),'not_your_turn',409);
 });

 await t.test('buyer projections never contain floors',async()=>{
  const r=ok(await call('GET',`/buy-requests/${request.request_id}`,buyer));
  assert.equal(r.budget_cents,40000);assert.equal(r.target_cents,36000);assert.ok(!has(r,'floor_cents'));assert.ok(!has(r,'buyer_id'));
  const s=r.sessions.find(x=>x.session_id===bs);
  assert.equal(s.turn,'buyer');assert.equal(s.version,1);assert.equal(s.rounds,1);
  assert.equal(s.current_offer.total_cents,46500);assert.deepEqual(s.current_offer.items.map(i=>i.title).sort(),['Bay 46in Walnut Desk','Bay Mesh Ergonomic Chair']);
  const offers=ok(await call('GET',`/buy-requests/${request.request_id}/offers`,buyer));
  assert.equal(offers.length,1);assert.equal(offers[0].offer_id,offer1.offer_id);assert.ok(!has(offers,'floor_cents'));
  assert.deepEqual([offers[0].session_version,offers[0].within_budget,offers[0].seller_name],[1,false,'Bay Desk Co']);
  const view=ok(await call('GET',`/sessions/${bs}`,buyer));
  assert.equal(view.role,'buyer');assert.ok(!has(view,'floor_cents'));assert.equal(view.history.length,1);
  err(await call('GET',`/buy-requests/${request.request_id}`,bay.token),'forbidden',403);
  // Legacy COMMERCE_DEMO_TOKEN acts as the configured demo buyer.
  assert.equal(ok(await call('GET',`/buy-requests/${request.request_id}`,LEGACY)).request_id,request.request_id);
 });

 await t.test('buyer counter: over budget, stale, ok, idempotent, wrong turn',async()=>{
  err(await call('POST',`/sessions/${bs}/counters`,buyer,{expected_version:1,total_cents:40001},randomUUID()),'budget_exceeded',409);
  err(await call('POST',`/sessions/${bs}/counters`,buyer,{expected_version:0,total_cents:36000},randomUUID()),'stale_offer',409);
  err(await call('POST',`/sessions/${bs}/counters`,bay.token,{expected_version:1,total_cents:36000},randomUUID()),'forbidden',403);
  const key=randomUUID(),body={expected_version:1,total_cents:36000,note:'Can you do $360 delivered?'};
  counter=ok(await call('POST',`/sessions/${bs}/counters`,buyer,body,key));
  assert.equal(counter.session_version,2);
  assert.deepEqual(ok(await call('POST',`/sessions/${bs}/counters`,buyer,body,key)),counter);
  err(await call('POST',`/sessions/${bs}/counters`,buyer,{...body,total_cents:35000},key),'idempotency_conflict',409);
  err(await call('POST',`/sessions/${bs}/counters`,buyer,{...body,expected_version:2},randomUUID()),'not_your_turn',409);
  const view=ok(await call('GET',`/sessions/${bs}`,bay.token));
  assert.equal(view.turn,'seller');assert.equal(view.latest_counter.total_cents,36000);
  assert.deepEqual(view.history.map(h=>h.type),['offer','counter']);assert.ok(!has(view,'budget_cents'));
 });

 await t.test('seller accepts by re-offering at the counter price; old offer superseded',async()=>{
  offer2=ok(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:2,items:lines(20500,13000),note:'Deal at $360.'},randomUUID()));
  assert.deepEqual({version:offer2.version,total_cents:offer2.total_cents,session_version:offer2.session_version},{version:2,total_cents:36000,session_version:3});
  const rows=await sql('SELECT id,is_current FROM commerce_offers WHERE session_id=$1 ORDER BY version',[bs]);
  assert.deepEqual(rows.map(r=>r.is_current),[false,true]);
  const s=(await sql('SELECT version,rounds,turn FROM commerce_sessions WHERE id=$1',[bs]))[0];
  assert.deepEqual(s,{version:3,rounds:2,turn:'buyer'});
 });

 await t.test('commerce_reserve on the negotiated seller offer',async()=>{
  err(await call('POST',`/offers/${offer1.offer_id}/reservations`,buyer,undefined,randomUUID()),'stale_offer',409);
  const key=randomUUID();
  const r=ok(await call('POST',`/offers/${offer2.offer_id}/reservations`,buyer,undefined,key));
  assert.equal(r.total_cents,36000);assert.equal(r.status,'held');
  assert.equal(ok(await call('POST',`/offers/${offer2.offer_id}/reservations`,buyer,undefined,key)).id,r.id);
  const stock=ok(await call('GET','/seller/inventory',bay.token));
  assert.equal(stock.find(i=>i.sku==='BAY-DESK-46').available,2);
  const q=ok(await call('GET',`/buy-requests/${request.request_id}`,buyer));
  assert.equal(q.status,'awaiting_payment');assert.equal(q.reservation.reservation_id,r.id);
  // Request is no longer negotiating: further moves are refused.
  err(await call('POST',`/sessions/${ms}/offers`,mission.token,{expected_version:0,items:[
   {inventory_id:inv(mission.seller_id,'MIS-DESK-48'),quantity:1,unit_cents:32000},
   {inventory_id:inv(mission.seller_id,'MIS-CHAIR-PRO'),quantity:1,unit_cents:21000}]},randomUUID()),'session_closed',409);
 });

 await t.test('decline by seller is idempotent and closes the session',async()=>{
  const d=ok(await call('POST',`/sessions/${ms}/decline`,mission.token,{reason:'Cannot meet the price.'},randomUUID()));
  assert.equal(d.status,'declined');
  assert.deepEqual(ok(await call('POST',`/sessions/${ms}/decline`,mission.token,{},randomUUID())),d);
  err(await call('POST',`/sessions/${ms}/decline`,bay.token,{},randomUUID()),'forbidden',403);
  err(await call('POST',`/sessions/${ms}/decline`,mission.token,{}),'idempotency_key_required',400);
 });

 await t.test('worker events: routed, redacted, ackable once',async()=>{
  err(await call('GET','/worker/events',bay.token),'forbidden',403);
  assert.deepEqual(ok(await call('POST',`/worker/sellers/${bay.seller_id}/agent`,P.worker.token,{agent_handle:'bay-desk-co'})),
   {seller_id:bay.seller_id,agent_handle:'bay-desk-co'});
  const events=[];
  for(;;) {
   const page=ok(await call('GET','/worker/events?limit=100',P.worker.token));
   if(!page.length) break;
   for(const e of page) {events.push(e);ok(await call('POST',`/worker/events/${e.id}/ack`,P.worker.token));}
  }
  const mine=events.filter(e=>e.route.request_id===request.request_id);
  assert.deepEqual(mine.map(e=>e.kind),['session.opened','session.opened','offer.created','counter.created','offer.created','session.declined']);
  const shapes={'session.opened':['request_id','session_id'],'offer.created':['note','offer_id','request_id','session_id','total_cents'],
   'counter.created':['counter_id','note','session_id','total_cents'],'session.declined':['session_id']};
  for(const e of events) assert.deepEqual(Object.keys(e.payload).sort(),shapes[e.kind],e.kind);
  const [{bad}]=await sql(`SELECT count(*)::int AS bad FROM commerce_outbox WHERE payload::text ~ '(budget|target|floor)'`);
  assert.equal(bad,0);
  const route=k=>mine.filter(e=>e.kind===k).map(e=>e.route);
  assert.ok(route('session.opened').every(r=>r.to_role==='seller'));
  assert.deepEqual(route('offer.created').map(r=>[r.to_role,r.seller_id,r.agent_handle]),[['buyer',bay.seller_id,'bay-desk-co'],['buyer',bay.seller_id,'bay-desk-co']]);
  assert.deepEqual(route('counter.created').map(r=>[r.to_role,r.seller_id]),[['seller',bay.seller_id]]);
  assert.deepEqual(route('session.declined').map(r=>[r.to_role,r.buyer_id]),[['buyer',P.buyer.actor_id]]);
  assert.equal(mine.find(e=>e.kind==='offer.created').payload.total_cents,46500);
  const again=ok(await call('POST',`/worker/events/${events[0].id}/ack`,P.worker.token));
  assert.equal(again.id,events[0].id);
  assert.deepEqual(ok(await call('GET','/worker/events',P.worker.token)),[]);
  err(await call('POST',`/worker/events/${randomUUID()}/ack`,P.worker.token),'event_not_found',404);
 });
});

test('buyer decline routes to the seller and blocks reserving that seller offer',async()=>{
 const [bay,mission]=P.sellers;
 const r=ok(await call('POST','/buy-requests',P.buyer.token,order,randomUUID()));
 const s=r.sessions.find(x=>x.seller_id===mission.seller_id).session_id;
 const o=ok(await call('POST',`/sessions/${s}/offers`,mission.token,{expected_version:0,items:[
  {inventory_id:seedId('inventory:mission-ergonomics:MIS-DESK-48'),quantity:1,unit_cents:26000},
  {inventory_id:seedId('inventory:mission-ergonomics:MIS-CHAIR-PRO'),quantity:1,unit_cents:16500}]},randomUUID()));
 assert.equal(o.total_cents,42500);
 err(await call('POST',`/offers/${o.offer_id}/reservations`,P.buyer.token,undefined,randomUUID()),'budget_exceeded');
 ok(await call('POST',`/sessions/${s}/decline`,P.buyer.token,{reason:'Over budget'},randomUUID()));
 err(await call('POST',`/sessions/${s}/counters`,P.buyer.token,{expected_version:2,total_cents:38000},randomUUID()),'session_closed',409);
 const events=ok(await call('GET','/worker/events?limit=100',P.worker.token)).filter(e=>e.payload.session_id===s);
 assert.deepEqual(events.map(e=>[e.kind,e.route.to_role]),[['session.opened','seller'],['offer.created','buyer'],['session.declined','seller']]);
 const offers=ok(await call('GET',`/buy-requests/${r.request_id}/offers`,P.buyer.token));
 assert.ok(!offers.some(x=>x.offer_id===o.offer_id));
 assert.ok(r.sessions.some(x=>x.seller_id===bay.seller_id));
});

test('direct RPC: concurrent request creation with one key creates one request',async()=>{
 const args={p_buyer:P.buyer.actor_id,p_key:randomUUID(),p_title:'t',p_requirements:requirements,p_budget_cents:40000,
  p_target_cents:null,p_deadline:null,p_delegate:true};
 const results=await Promise.all(Array.from({length:5},()=>db.database.rpc('commerce_create_request',args)));
 assert.ok(results.every(r=>!r.error),JSON.stringify(results.map(r=>r.error)));
 assert.equal(new Set(results.map(r=>r.data.request_id)).size,1);
 const [{n}]=await sql('SELECT count(*)::int AS n FROM commerce_outbox o JOIN commerce_sessions s ON s.id=o.aggregate_id WHERE s.request_id=$1',[results[0].data.request_id]);
 assert.equal(n,2);
 const bad=await db.database.rpc('commerce_create_request',{...args,p_key:randomUUID(),p_target_cents:50000});
 assert.equal(bad.error.message,'invalid_input');
});

test('re-seeding rotates tokens and keeps fixture IDs',async()=>{
 const again=await seed(db);
 assert.deepEqual(again.sellers.map(s=>s.seller_id),P.sellers.map(s=>s.seller_id));
 assert.notEqual(again.buyer.token,P.buyer.token);
 err(await call('GET','/me',P.buyer.token),'unauthorized',401);
 assert.equal(ok(await call('GET','/me',again.buyer.token)).actor_id,P.buyer.actor_id);
 P=again;
});

test('anon and authenticated roles cannot touch new tables or functions',async()=>{
 const rows=await sql(`SELECT r.rolname, t.t, has_table_privilege(r.rolname,'public.'||t.t,'SELECT,INSERT,UPDATE,DELETE') AS priv
  FROM unnest(ARRAY['anon','authenticated']) r(rolname) CROSS JOIN unnest(ARRAY['commerce_sessions','commerce_counters','commerce_principals']) t(t)`);
 assert.ok(rows.every(r=>r.priv===false));
 const fns=await sql(`SELECT p.oid::regprocedure::text AS f, has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth, has_function_privilege('project_admin',p.oid,'EXECUTE') AS admin
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'commerce_%'`);
 assert.ok(fns.length>=23);
 for(const f of fns) assert.deepEqual([f.anon,f.auth,f.admin],[false,false,true],f.f);
 const rls=await sql(`SELECT relname FROM pg_class WHERE relname IN ('commerce_sessions','commerce_counters','commerce_principals') AND relrowsecurity`);
 assert.equal(rls.length,3);
});
