// Real-database checks for hardening round 1 (migrations/20261018000800_hardening.sql,
// doc/hardening-contract.md). Run with `npm run test:db`. Drives the production HTTP app plus the payment
// RPC: round and request caps, matching (own businesses, regions, delivery deadline), key replay rules,
// closing losing sessions on payment, the buyer's order notice, the sweep, notes, offer TTL and the
// feed versions (v1 unchanged for running runners, v2 adds the new kinds).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import type Stripe from 'stripe';
import { pgDb } from '../../scripts/pg-db.ts';
import { seed } from '../../scripts/seed-negotiation.ts';
import type { DemoPrincipals } from '../../scripts/seed-negotiation.ts';
import { mintAgentTokens } from '../../scripts/agent-tokens.ts';
import type { AgentPrincipals } from '../../scripts/agent-tokens.ts';
import { Commerce, CommerceError } from '../../src/commerce.ts';
import { Negotiation, hashToken } from '../../src/negotiation.ts';
import { createApp } from '../../src/server.ts';
import type { AppOptions } from '../../src/server.ts';
import type {
 ApiError, CreatedCounter, CreatedOffer, CreatedRequest, EventAck, RegisteredBusiness, ReservationRow, Row, SweepResult, WorkerEvent,
} from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const db=pgDb(process.env.DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
let server: ReturnType<typeof createApp>,base: string,P: DemoPrincipals,A: AgentPrincipals,commerce: Commerce;
const shops: string[]=[];
before(async()=>{
 P=await seed(db);
 A=(await mintAgentTokens(db)).principals;
 commerce=new Commerce({db,stripe:{} as Stripe,webhookSecret:'whsec_unused',baseUrl:'http://127.0.0.1',integrationId:'test'});
 const auth={authenticate:async()=>{throw new CommerceError('unauthorized',401);}} as unknown as AppOptions['auth'];
 server=createApp({commerce,negotiation:new Negotiation({db}),auth});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
// Leave the shared database as later files expect: our businesses never match their orders and no event
// of ours stays pending in either feed version.
after(async()=>{
 if(shops.length) await sql('UPDATE commerce_sellers SET enabled=false WHERE id=ANY($1::uuid[])',[shops]);
 await sql("UPDATE commerce_outbox SET delivered_at=now() WHERE delivered_at IS NULL AND kind<>'order.confirmed'");
 server?.close();await db.end();
});

interface Reply { status: number; body: {data?: unknown; error?: ApiError} }
async function call(method: string,path: string,auth?: string,body?: unknown,key?: string): Promise<Reply> {
 const headers: Record<string,string>={};
 if(auth) headers.authorization=`Bearer ${auth}`;
 if(key) headers['idempotency-key']=key;
 if(body!==undefined) headers['content-type']='application/json';
 const res=await fetch(base+'/api/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as Reply['body']};
}
const ok=<T=unknown,>(r: Reply)=>{assert.ok(r.body.data!==undefined,JSON.stringify(r.body));return r.body.data as T;};
const err=(r: Reply,code: string,status: number)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));assert.equal(r.status,status);};
const requirements={region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
const seller=(name: string)=>P.sellers.find(s=>s.name===name)!;
const inv=async(sellerId: string,category: string)=>(await sql<{id: string; list_cents: number}>(
 "SELECT id,list_cents FROM commerce_inventory WHERE seller_id=$1 AND category=$2 AND (category<>'desk' OR (attributes->>'width_in')::numeric<=48) AND (category<>'chair' OR attributes->>'ergonomic'='true') ORDER BY sku LIMIT 1",
 [sellerId,category]))[0];
async function listOffer(sellerName: string,session: string,version: number,note='At list.') {
 const s=seller(sellerName);
 const items=await Promise.all(['desk','chair'].map(async c=>{const i=await inv(s.seller_id,c);return {inventory_id:i.id,quantity:1,unit_cents:i.list_cents};}));
 return ok<CreatedOffer>(await call('POST',`/sessions/${session}/offers`,s.token,{expected_version:version,items,note},randomUUID()));
}
const order=(extra: Record<string,unknown>={})=>({title:'Hardening desk and chair',requirements,budget_cents:60000,target_cents:30000,...extra});
const sessionOf=(r: CreatedRequest,name: string)=>r.sessions.find(s=>s.seller_id===seller(name).seller_id)?.session_id;
/** A signed-up person (non-demo actor) with a buyer role token. */
async function person(email: string) {
 const userId=randomUUID(),token=randomBytes(32).toString('hex');
 await sql('INSERT INTO auth.users(id,email) VALUES($1,$2)',[userId,email]);
 const [{id}]=await sql<{id: string}>("INSERT INTO commerce_actors(auth_user_id,label) VALUES($1,'Exchangent user') RETURNING id",[userId]);
 await sql("INSERT INTO commerce_principals(token_hash,actor_id,scope,label) VALUES($1,$2,'buyer','test:hardening')",[hashToken(token),id]);
 return {actorId:id,token};
}
async function feed(v?: number) {
 return ok<WorkerEvent[]>(await call('GET',`/worker/events?limit=100${v?`&v=${v}`:''}`,P.worker.token));
}

test('round limit: after the 8th seller offer a counter closes the session (committed) and answers 409 round_limit',async()=>{
 const r=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),randomUUID()));
 const bs=sessionOf(r,'Bay Desk Co')!;
 const first=await listOffer('Bay Desk Co',bs,0);
 const offer=(await sql<{expires_at: Date}>('SELECT expires_at FROM commerce_offers WHERE id=$1',[first.offer_id]))[0];
 const hours=(offer.expires_at.getTime()-Date.now())/3600000;
 assert.ok(hours>23.5&&hours<=24.01,`offers last 24 hours (got ${hours})`);
 await sql('UPDATE commerce_sessions SET rounds=8 WHERE id=$1',[bs]);
 err(await call('POST',`/sessions/${bs}/counters`,P.buyer.token,{expected_version:first.session_version,total_cents:30000},randomUUID()),'round_limit',409);
 const [s]=await sql<{status: string; decline_reason: string}>('SELECT status,decline_reason FROM commerce_sessions WHERE id=$1',[bs]);
 assert.deepEqual(s,{status:'closed',decline_reason:'round limit'});
 assert.equal((await sql('SELECT 1 FROM commerce_offers WHERE id=$1 AND is_current',[first.offer_id])).length,0,'a closed session\'s offer cannot be reserved');
 err(await call('POST',`/sessions/${bs}/counters`,P.buyer.token,{expected_version:first.session_version+1,total_cents:30000},randomUUID()),'session_closed',409);
 const closed=(await feed(2)).find(e=>e.kind==='session.closed'&&e.payload.session_id===bs)!;
 assert.ok(closed,'v2 feed carries session.closed');
 assert.deepEqual(closed.payload,{session_id:bs,request_id:r.request_id,reason:'round limit'});
 assert.equal(closed.route.to_role,'seller');assert.equal(closed.route.seller_id,seller('Bay Desk Co').seller_id);
 assert.ok(!(await feed()).some(e=>e.kind==='session.closed'),'the v1 feed (running runners) never shows it');

 // Seller side: the 9th offer is refused the same way.
 const r2=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),randomUUID()));
 const bs2=sessionOf(r2,'Bay Desk Co')!;
 const o2=await listOffer('Bay Desk Co',bs2,0);
 const c2=ok<CreatedCounter>(await call('POST',`/sessions/${bs2}/counters`,A.buyer.token,{expected_version:o2.session_version,total_cents:30000},randomUUID()));
 await sql('UPDATE commerce_sessions SET rounds=8 WHERE id=$1',[bs2]);
 const s2=seller('Bay Desk Co'),desk=await inv(s2.seller_id,'desk'),chair=await inv(s2.seller_id,'chair');
 err(await call('POST',`/sessions/${bs2}/offers`,s2.token,{expected_version:c2.session_version,
  items:[{inventory_id:desk.id,quantity:1,unit_cents:desk.list_cents},{inventory_id:chair.id,quantity:1,unit_cents:chair.list_cents}]},randomUUID()),'round_limit',409);
 assert.equal((await sql<{status: string}>('SELECT status FROM commerce_sessions WHERE id=$1',[bs2]))[0].status,'closed');
});

test('notes are capped at 500 characters on offers and counters',async()=>{
 const r=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),randomUUID()));
 const bs=sessionOf(r,'Bay Desk Co')!,s=seller('Bay Desk Co');
 const desk=await inv(s.seller_id,'desk'),chair=await inv(s.seller_id,'chair');
 const items=[{inventory_id:desk.id,quantity:1,unit_cents:desk.list_cents},{inventory_id:chair.id,quantity:1,unit_cents:chair.list_cents}];
 err(await call('POST',`/sessions/${bs}/offers`,s.token,{expected_version:0,items,note:'x'.repeat(501)},randomUUID()),'invalid_input',400);
 const o=ok<CreatedOffer>(await call('POST',`/sessions/${bs}/offers`,s.token,{expected_version:0,items,note:'y'.repeat(500)},randomUUID()));
 err(await call('POST',`/sessions/${bs}/counters`,P.buyer.token,{expected_version:o.session_version,total_cents:30000,note:'z'.repeat(501)},randomUUID()),'invalid_input',400);
 // The SQL enforces the cap too (any caller that skips the HTTP validation).
 const {error}=await db.database.rpc('commerce_buyer_counter',{p_buyer:P.buyer.actor_id,p_session:bs,p_key:randomUUID(),
  p_expected_version:o.session_version,p_total_cents:30000,p_note:'z'.repeat(501)});
 assert.equal(error?.message,'invalid_input');
});

test('request caps for people: 5 open, 20 per day; a live retry still replays at the cap',async()=>{
 const me=await person('Caps.Hardening@example.test');
 const nowhere={...order(),requirements:{region:'oakland',items:[{category:'desk'}]}};
 const keys=Array.from({length:5},()=>randomUUID());
 const made=[];
 for(const k of keys) made.push(ok<CreatedRequest>(await call('POST','/buy-requests',me.token,nowhere,k)));
 assert.equal(made.every(m=>m.sessions.length===0),true,'no sellers in oakland: zero matches is not an error');
 err(await call('POST','/buy-requests',me.token,nowhere,randomUUID()),'too_many_requests',429);
 assert.equal(ok<CreatedRequest>(await call('POST','/buy-requests',me.token,nowhere,keys[0])).request_id,made[0].request_id);
 await sql("UPDATE commerce_requests SET status='confirmed' WHERE id=ANY($1::uuid[])",[[made[0].request_id,made[1].request_id]]);
 ok(await call('POST','/buy-requests',me.token,nowhere,randomUUID()));
 // 6 created today; 14 more (already confirmed) make 20 in 24 hours.
 await sql(`INSERT INTO commerce_requests(buyer_id,budget_cents,status,idempotency_key)
  SELECT $1,1000,'confirmed','bulk-'||g FROM generate_series(1,14) g`,[me.actorId]);
 await sql("UPDATE commerce_requests SET status='confirmed' WHERE buyer_id=$1",[me.actorId]);
 err(await call('POST','/buy-requests',me.token,nowhere,randomUUID()),'too_many_requests',429);
 // Seeded demo actors (platform-run) have no caps: every other test file creates many requests for one.
});

test('matching: never your own business; regions are normalized; deliver_by and deadline are enforced',async()=>{
 const me=await person('Self.Hardening@example.test');
 const shop=ok<RegisteredBusiness>(await call('POST','/businesses',me.token,{name:'Hardening Self Shop',service_area:'San Francisco',delivery_days:1}));
 shops.push(shop.business.seller_id);
 assert.equal(shop.business.service_area,'san_francisco','service areas are stored normalized');
 await sql(`INSERT INTO commerce_inventory(seller_id,sku,title,category,attributes,list_cents,floor_cents,available) VALUES
  ($1,'HS-DESK','Self desk','desk','{"width_in":40}',20000,15000,3),($1,'HS-CHAIR','Self chair','chair','{"ergonomic":true}',15000,10000,3)`,[shop.business.seller_id]);
 const mine=ok<CreatedRequest>(await call('POST','/buy-requests',me.token,order(),randomUUID()));
 assert.ok(!mine.sessions.some(s=>s.seller_id===shop.business.seller_id),'own business not matched');
 assert.ok(sessionOf(mine,'Bay Desk Co'),'other sellers still match');
 const theirs=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),randomUUID()));
 assert.ok(theirs.sessions.some(s=>s.seller_id===shop.business.seller_id),'another buyer matches it');

 for(const region of ['SF','San Francisco, CA','san-francisco',' San Francisco ']) {
  const r=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order({requirements:{...requirements,region}}),randomUUID()));
  assert.ok(sessionOf(r,'Bay Desk Co'),`region ${JSON.stringify(region)} matches san_francisco`);
 }
 const oak=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order({requirements:{...requirements,region:'Oakland'}}),randomUUID()));
 assert.equal(oak.sessions.length,0);

 // Bay delivers in 1 day, Mission in 2: a 36-hour deadline admits only Bay.
 const in36h=new Date(Date.now()+36*3600000).toISOString();
 const soon=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order({requirements:{...requirements,deliver_by:in36h}}),randomUUID()));
 assert.ok(sessionOf(soon,'Bay Desk Co'));assert.equal(sessionOf(soon,'Mission Ergonomics'),undefined);
 const [{deadline}]=await sql<{deadline: Date}>('SELECT deadline FROM commerce_requests WHERE id=$1',[soon.request_id]);
 assert.equal(deadline.toISOString(),in36h,'deliver_by becomes the request deadline');
 // A date means the end of that day anywhere on Earth: the next day, 12:00 UTC.
 const dated=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order({requirements:{...requirements,deliver_by:'2099-12-31'}}),randomUUID()));
 assert.equal((await sql<{deadline: Date}>('SELECT deadline FROM commerce_requests WHERE id=$1',[dated.request_id]))[0].deadline.toISOString(),'2100-01-01T12:00:00.000Z');
 assert.ok(sessionOf(dated,'Mission Ergonomics'));
 // Unparseable deliver_by is ignored, as before.
 const vague=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order({requirements:{...requirements,deliver_by:'tomorrow'}}),randomUUID()));
 assert.ok(sessionOf(vague,'Mission Ergonomics'));
 assert.equal((await sql<{deadline: Date|null}>('SELECT deadline FROM commerce_requests WHERE id=$1',[vague.request_id]))[0].deadline,null);
 // An explicit deadline wins over deliver_by; a past one matches nobody.
 const past=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,
  order({deadline:new Date(Date.now()-3600000).toISOString(),requirements:{...requirements,deliver_by:'2099-12-31'}}),randomUUID()));
 assert.equal(past.sessions.length,0);
});

test('a request key replays only a live request; a dead hold\'s key starts a new hold',async()=>{
 const key=randomUUID();
 const first=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),key));
 assert.equal(ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),key)).request_id,first.request_id);
 await sql("UPDATE commerce_requests SET status='confirmed' WHERE id=$1",[first.request_id]);
 const again=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),key));
 assert.notEqual(again.request_id,first.request_id,'identical wording after a confirmed order is a new order');
 assert.equal(ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order(),key)).request_id,again.request_id);

 const bs=sessionOf(again,'Bay Desk Co')!;
 const offer=await listOffer('Bay Desk Co',bs,0);
 const hold=randomUUID();
 const held=ok<ReservationRow>(await call('POST',`/offers/${offer.offer_id}/reservations`,P.buyer.token,{expected_total_cents:offer.total_cents},hold));
 assert.equal(ok<ReservationRow>(await call('POST',`/offers/${offer.offer_id}/reservations`,P.buyer.token,{expected_total_cents:offer.total_cents},hold)).id,held.id);
 // The hold can no longer open checkout, so the next reserve releases it; the same key then starts a new hold.
 await sql("UPDATE commerce_reservations SET expires_at=now() WHERE id=$1",[held.id]);
 const fresh=ok<ReservationRow>(await call('POST',`/offers/${offer.offer_id}/reservations`,P.buyer.token,{expected_total_cents:offer.total_cents},hold));
 assert.notEqual(fresh.id,held.id);assert.equal(fresh.status,'held');
 const [old]=await sql<{status: string; idempotency_key: string}>('SELECT status,idempotency_key FROM commerce_reservations WHERE id=$1',[held.id]);
 assert.equal(old.status,'expired');assert.equal(old.idempotency_key,`${hold}#${held.id}`);

 // Checkout lines for this hold: the reserved items plus delivery, adding up to the total.
 const row=(await sql<ReservationRow>('SELECT * FROM commerce_reservations WHERE id=$1',[fresh.id]))[0];
 const lines=await commerce.checkoutLines(row);
 assert.equal(lines.reduce((n,l)=>n+l.quantity*l.price_data.unit_amount,0),fresh.total_cents);
 assert.ok(lines.some(l=>l.price_data.product_data.name==='Delivery'));
 assert.ok(lines.every(l=>l.price_data.product_data.description==='Sold by Bay Desk Co via Exchangent'));
});

test('payment closes the losing sessions, stores the PaymentIntent and writes the buyer\'s order notice',async()=>{
 await feed(2).then(async page=>{for(const e of page) ok(await call('POST',`/worker/events/${e.id}/ack`,P.worker.token));});
 const r=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order({title:'Paid hardening order'}),randomUUID()));
 const bs=sessionOf(r,'Bay Desk Co')!,ms=sessionOf(r,'Mission Ergonomics')!;
 const bay=await listOffer('Bay Desk Co',bs,0);
 const mission=await listOffer('Mission Ergonomics',ms,0);
 const held=ok<ReservationRow>(await call('POST',`/offers/${bay.offer_id}/reservations`,P.buyer.token,{expected_total_cents:bay.total_cents},randomUUID()));
 const cs=`cs_test_${randomUUID().replaceAll('-','')}`;
 assert.equal((await db.database.rpc('commerce_bind_checkout',{p_reservation:held.id,p_session:cs,p_url:'https://checkout.test'})).error,null);
 const paid=await db.database.rpc('commerce_apply_payment',{p_event:`evt_${randomUUID()}`,p_type:'checkout.session.completed',
  p_reservation:held.id,p_session:cs,p_total:held.total_cents,p_currency:'usd',p_paid:true,p_release:false,p_pending:false,p_payment_intent:'pi_test_hardening'});
 assert.equal(paid.error,null,JSON.stringify(paid.error));
 const [ord]=await sql<{id: string; stripe_payment_intent: string}>('SELECT id,stripe_payment_intent FROM commerce_orders WHERE reservation_id=$1',[held.id]);
 assert.equal(ord.stripe_payment_intent,'pi_test_hardening');
 const sessions=await sql<{id: string; status: string; decline_reason: string|null}>('SELECT id,status,decline_reason FROM commerce_sessions WHERE request_id=$1',[r.request_id]);
 assert.deepEqual(sessions.find(s=>s.id===ms),{id:ms,status:'closed',decline_reason:'another offer was accepted'});
 assert.equal(sessions.find(s=>s.id===bs)?.status,'open','the winning session is left as it was');
 assert.equal((await sql('SELECT 1 FROM commerce_offers WHERE id=$1 AND is_current',[mission.offer_id])).length,0);

 const v2=(await feed(2)).filter(e=>e.route.request_id===r.request_id);
 const losers=v2.filter(e=>e.kind==='session.closed');
 assert.equal(losers.length,r.sessions.length-1,'every other seller\'s session closes');
 const closed=losers.find(e=>e.payload.session_id===ms)!;
 assert.deepEqual(closed.payload,{session_id:ms,request_id:r.request_id,reason:'another offer was accepted'});
 assert.equal(closed.route.seller_id,seller('Mission Ergonomics').seller_id);
 const notices=v2.filter(e=>e.kind==='order.confirmed');
 assert.deepEqual(notices.map(e=>e.route.to_role).sort(),['buyer','seller']);
 const mineNotice=notices.find(e=>e.route.to_role==='buyer')!;
 assert.deepEqual(mineNotice.payload,{order_id:ord.id,reservation_id:held.id,request_id:r.request_id,seller_id:seller('Bay Desk Co').seller_id,
  seller_name:'Bay Desk Co',total_cents:held.total_cents,currency:'usd',title:'Paid hardening order'});
 assert.equal(mineNotice.route.buyer_id,P.buyer.actor_id);assert.equal(mineNotice.route.delegated,true);
 assert.ok(!JSON.stringify(v2).match(/budget|target|floor|buyer_email/),'no private numbers or email in the feed');
 // Feed v1 is exactly what running runners already understand.
 const v1=(await feed()).filter(e=>e.route.request_id===r.request_id);
 assert.deepEqual(v1.map(e=>[e.kind,e.route.to_role]).filter(([k])=>k==='order.confirmed'||k==='session.closed'),[['order.confirmed','seller']]);
 assert.deepEqual(ok<EventAck>(await call('POST',`/worker/events/${mineNotice.id}/ack`,P.worker.token)).kind,'order.confirmed');
 assert.deepEqual(ok<EventAck>(await call('POST',`/worker/events/${closed.id}/ack`,P.worker.token)).kind,'session.closed');
 err(await call('GET','/worker/events?v=3',P.worker.token),'invalid_input',400);
});

test('sweep: expires negotiating requests past their deadline and closes their sessions; stale holds go too',async()=>{
 const r=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,
  order({deadline:new Date(Date.now()+30*86400000).toISOString()}),randomUUID()));
 const bs=sessionOf(r,'Bay Desk Co')!;
 const offer=await listOffer('Bay Desk Co',bs,0);
 await sql("UPDATE commerce_requests SET deadline=now()-interval '1 minute' WHERE id=$1",[r.request_id]);
 err(await call('POST','/worker/sweep',P.buyer.token),'forbidden',403);
 const swept=ok<SweepResult>(await call('POST','/worker/sweep',P.worker.token));
 assert.ok(swept.expired_requests>=1&&swept.closed_sessions>=r.sessions.length,JSON.stringify(swept));
 assert.equal(typeof swept.released_holds,'number');
 assert.equal((await sql<{status: string}>('SELECT status FROM commerce_requests WHERE id=$1',[r.request_id]))[0].status,'expired');
 const sessions=await sql<{status: string; decline_reason: string}>('SELECT status,decline_reason FROM commerce_sessions WHERE request_id=$1',[r.request_id]);
 assert.ok(sessions.every(s=>s.status==='closed'&&s.decline_reason==='deadline passed'));
 const closed=(await feed(2)).filter(e=>e.kind==='session.closed'&&e.route.request_id===r.request_id);
 assert.equal(closed.length,r.sessions.length);
 err(await call('POST',`/offers/${offer.offer_id}/reservations`,P.buyer.token,{expected_total_cents:offer.total_cents},randomUUID()),'request_expired',409);
 // Idempotent: nothing left to expire for this request.
 const again=ok<SweepResult>(await call('POST','/worker/sweep',P.worker.token));
 assert.equal((await sql('SELECT 1 FROM commerce_sessions WHERE request_id=$1 AND status=$2',[r.request_id,'open'])).length,0);
 assert.equal(typeof again.closed_sessions,'number');
});

test('anon and authenticated roles cannot run the new functions',async()=>{
 const fns=['commerce_norm_region(text)','commerce_deliver_by_deadline(jsonb)','commerce_close_session(uuid,text)','commerce_sweep()',
  'commerce_worker_events(integer,integer)','commerce_apply_payment(text,text,uuid,text,integer,text,boolean,boolean,boolean,text)'];
 for(const role of ['anon','authenticated']) for(const fn of fns) {
  const [{allowed}]=await sql<{allowed: boolean}>('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[role,`public.${fn}`]);
  assert.equal(allowed,false,`${role} ${fn}`);
 }
});
