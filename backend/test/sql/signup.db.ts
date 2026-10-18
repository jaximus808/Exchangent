// Real-database checks for self-serve businesses and the platform seller agent
// (migrations/20261018000600_self-serve-signup.sql, doc/signup-contract.md). Run with `npm run test:db`.
// Drives the production HTTP app: consent-page registration (a stubbed InsForge user session),
// buyer-token registration, owner settings and stock, worker-minted seller agent tokens, the
// sale notice in the worker feed, and the migration on a database with duplicate business names.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
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
 ApiError, BusinessJson, CreatedOffer, CreatedRequest, EventAck, InventoryItem, RegisteredBusiness, ReservationRow, Row,
 RolePrincipal, SellerAgentToken, WorkerEvent,
} from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const DATABASE_URL=process.env.DATABASE_URL;
const db=pgDb(DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
const migrations=fileURLToPath(new URL('../../../migrations/',import.meta.url));
const SESSION='Bearer user-session-owner';
const owner={userId:randomUUID(),email:'Owner.Signup@example.test',actorId:'',buyerToken:randomBytes(32).toString('hex'),sellerToken:randomBytes(32).toString('hex')};
let server: ReturnType<typeof createApp>,base: string,P: DemoPrincipals,A: AgentPrincipals,shop: BusinessJson,agentToken: string;
let request: CreatedRequest,session: string,offer: CreatedOffer;
before(async()=>{
 P=await seed(db);
 A=(await mintAgentTokens(db)).principals;
 await sql('INSERT INTO auth.users(id,email) VALUES($1,$2)',[owner.userId,owner.email]);
 owner.actorId=(await sql<{id: string}>("INSERT INTO commerce_actors(auth_user_id,label) VALUES($1,'Exchangent user') RETURNING id",[owner.userId]))[0].id;
 await sql("INSERT INTO commerce_principals(token_hash,actor_id,scope,label) VALUES($1,$2,'buyer','test:owner-buyer')",[hashToken(owner.buyerToken),owner.actorId]);
 const commerce=new Commerce({db,stripe:{} as Stripe,webhookSecret:'whsec_unused',baseUrl:'http://127.0.0.1',integrationId:'test'});
 // Stands in for a verified InsForge user session (the consent page's cookie token).
 const auth={authenticate:async(header?: string)=>{
  if(header===SESSION) return {kind:'user',actorId:owner.actorId,userId:owner.userId,email:owner.email};
  throw new CommerceError('unauthorized',401);
 }} as unknown as AppOptions['auth'];
 server=createApp({commerce,negotiation:new Negotiation({db}),auth});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{server?.close();await db.end();});

interface Reply { status: number; body: {data?: unknown; error?: ApiError} }
async function call(method: string,path: string,auth?: string,body?: unknown,key?: string): Promise<Reply> {
 const headers: Record<string,string>={};
 if(auth) headers.authorization=auth.startsWith('Bearer ')?auth:`Bearer ${auth}`;
 if(key) headers['idempotency-key']=key;
 if(body!==undefined) headers['content-type']='application/json';
 const res=await fetch(base+'/api/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as Reply['body']};
}
const ok=<T=unknown,>(r: Reply)=>{assert.ok(r.body.data!==undefined,JSON.stringify(r.body));return r.body.data as T;};
const err=(r: Reply,code: string,status: number)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));assert.equal(r.status,status);
 assert.ok(r.body.error!.next_action);};
const requirements={region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
const order=(title: string)=>({title,requirements,budget_cents:60000,target_cents:40000});
/** Drain the worker feed (acking everything) and return the events seen. */
async function drain() {
 const seen: WorkerEvent[]=[];
 for(;;) {
  const page=ok<WorkerEvent[]>(await call('GET','/worker/events?limit=100',P.worker.token));
  if(!page.length) return seen;
  for(const e of page) {seen.push(e);ok(await call('POST',`/worker/events/${e.id}/ack`,P.worker.token));}
 }
}

test('register a business from the consent page or a buyer token; names are unique case-insensitively',async()=>{
 const created=await call('POST','/businesses',SESSION,{name:'Hayes Valley Desks',delivery_cents:1500,delivery_days:1});
 assert.equal(created.status,201);
 shop=ok<BusinessJson>(created);
 assert.deepEqual({...shop,seller_id:'',created_at:''},{seller_id:'',name:'Hayes Valley Desks',service_area:'san_francisco',delivery_cents:1500,
  delivery_days:1,delegate_negotiation:true,enabled:true,agent_handle:null,created_at:'',owner_email:owner.email});
 const [{owner_id}]=await sql<{owner_id: string}>('SELECT owner_id FROM commerce_sellers WHERE id=$1',[shop.seller_id]);
 assert.equal(owner_id,owner.actorId);
 err(await call('POST','/businesses',owner.buyerToken,{name:'  hayes valley DESKS '}),'business_name_taken',409);
 err(await call('POST','/businesses',owner.buyerToken,{name:'bay desk co'}),'business_name_taken',409);
 const second=ok<RegisteredBusiness>(await call('POST','/businesses',owner.buyerToken,{name:'Owner Second Shop'}));
 assert.equal(second.business.delivery_days,2);assert.equal(second.business.delivery_cents,0);
 assert.match(second.next,/choose Owner Second Shop/);
 for(const bad of [{},{name:'x'},{name:'Fine Name',service_area:'San Francisco 94103'},{name:'Fine Name',delivery_days:31},
  {name:'Fine Name',delivery_cents:-1},{name:'Fine Name',delivery_cents:'1500'}])
  err(await call('POST','/businesses',owner.buyerToken,bad),'invalid_input',400);
 for(let i=3;i<=5;i++) ok(await call('POST','/businesses',owner.buyerToken,{name:`Owner Shop ${i}`}));
 err(await call('POST','/businesses',owner.buyerToken,{name:'Owner Shop 6'}),'business_limit',409);
 // Only a person registers: not the platform agents, not a seller token, not anonymous.
 err(await call('POST','/businesses',A.buyer.token,{name:'Agent Shop'}),'forbidden',403);
 err(await call('POST','/businesses',P.sellers[0].token,{name:'Seller Shop'}),'forbidden',403);
 err(await call('POST','/businesses',P.worker.token,{name:'Worker Shop'}),'forbidden',403);
 err(await call('POST','/businesses',undefined,{name:'Anon Shop'}),'unauthorized',401);
});

test('the owner stocks and configures the business; a matching order opens a session for it',async()=>{
 await sql("INSERT INTO commerce_principals(token_hash,actor_id,scope,seller_id,label) VALUES($1,$2,'seller',$3,'test:owner-seller')",
  [hashToken(owner.sellerToken),owner.actorId,shop.seller_id]);
 const me=owner.sellerToken;
 assert.equal(ok<BusinessJson>(await call('GET','/seller/business',me)).owner_email,owner.email);
 const desk=ok<InventoryItem>(await call('POST','/seller/inventory',me,{title:'Walnut desk 46in',category:'desk',attributes:{width_in:46},
  list_cents:30000,floor_cents:21000,available:3}));
 assert.equal(desk.sku,'walnut-desk-46in');assert.equal(desk.floor_cents,21000);assert.equal(desk.sold,0);
 const chair=ok<InventoryItem>(await call('POST','/seller/inventory',me,{sku:'HV-CHAIR',title:'Ergo mesh chair',category:'chair',
  attributes:{ergonomic:true},list_cents:20000,floor_cents:12000,available:2}));
 const again=ok<InventoryItem>(await call('POST','/seller/inventory',me,{sku:'HV-CHAIR',title:'Ergo mesh chair',category:'chair',
  attributes:{ergonomic:true},list_cents:19500,floor_cents:12000,available:4}));
 assert.equal(again.inventory_id,chair.inventory_id);assert.equal(again.available,4);assert.equal(again.list_cents,19500);
 for(const bad of [{title:'Desk',category:'desk',list_cents:100,floor_cents:200,available:1},
  {title:'Desk',category:'Desk',list_cents:200,floor_cents:100,available:1},
  {title:'Desk',category:'desk',list_cents:200,floor_cents:100,available:1,owner:'x'},
  {title:'Desk',category:'desk',list_cents:200.5,floor_cents:100,available:1},
  {title:'Desk',category:'desk',list_cents:200,floor_cents:100,available:-1},
  {title:'!!!',category:'desk',list_cents:200,floor_cents:100,available:1},
  {category:'desk',list_cents:200,floor_cents:100,available:1}])
  err(await call('POST','/seller/inventory',me,bad),'invalid_input',400);
 assert.equal(ok<InventoryItem[]>(await call('GET','/seller/inventory',me)).length,2);

 const updated=ok<BusinessJson>(await call('PATCH','/seller/business',me,{delivery_cents:2000,name:'hayes valley desks'}));
 assert.equal(updated.delivery_cents,2000);assert.equal(updated.name,'hayes valley desks');
 ok(await call('PATCH','/seller/business',me,{name:'Hayes Valley Desks'}));
 err(await call('PATCH','/seller/business',me,{name:'MISSION ERGONOMICS'}),'business_name_taken',409);
 for(const bad of [{enabled:false},{delivery_days:'1'},{delegate_negotiation:'no'},{name:'x'},{delivery_cents:1.5}])
  err(await call('PATCH','/seller/business',me,bad),'invalid_input',400);
 err(await call('PATCH','/seller/business',owner.buyerToken,{delivery_cents:1}),'forbidden',403);
 err(await call('POST','/seller/inventory',P.buyer.token,{}),'forbidden',403);

 await drain();
 request=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order('Desk and chair from a real shop'),randomUUID()));
 const mine=request.sessions.find(s=>s.seller_id===shop.seller_id);
 assert.ok(mine,JSON.stringify(request.sessions));assert.equal(mine.seller_name,'Hayes Valley Desks');
 session=mine.session_id;
 const opened=(await drain()).filter(e=>e.kind==='session.opened'&&e.route.seller_id===shop.seller_id);
 assert.equal(opened.length,1);assert.equal(opened[0].route.seller_delegated,true);assert.equal(opened[0].route.to_role,'seller');
});

test('the worker mints a seller agent token that negotiates but never edits the business',async()=>{
 err(await call('POST',`/worker/sellers/${shop.seller_id}/token`,P.buyer.token,{}),'forbidden',403);
 err(await call('POST',`/worker/sellers/${randomUUID()}/token`,P.worker.token,{}),'seller_not_found',404);
 err(await call('POST',`/worker/sellers/${shop.seller_id}/token`,P.worker.token,{hours:0}),'invalid_input',400);
 const minted=ok<SellerAgentToken>(await call('POST',`/worker/sellers/${shop.seller_id}/token`,P.worker.token,{hours:2}));
 assert.match(minted.token,/^[0-9a-f]{64}$/);assert.equal(minted.seller_id,shop.seller_id);assert.equal(minted.name,'Hayes Valley Desks');
 const hours=(Date.parse(minted.expires_at)-Date.now())/3600e3;assert.ok(hours>1.9&&hours<=2,String(hours));
 const [row]=await sql<{token_hash: string; label: string; actor_id: string}>('SELECT token_hash,label,actor_id FROM commerce_principals WHERE token_hash=$1',
  [hashToken(minted.token)]);
 assert.equal(row.label,`agents:seller-agent:${shop.seller_id}`);assert.equal(row.actor_id,owner.actorId);
 assert.equal((await sql('SELECT 1 FROM commerce_principals WHERE token_hash=$1',[minted.token])).length,0);
 agentToken=minted.token;
 assert.deepEqual(ok<RolePrincipal>(await call('GET','/me',agentToken)),{scope:'seller',actor_id:owner.actorId,seller_id:shop.seller_id,
  label:`agents:seller-agent:${shop.seller_id}`});
 const stock=ok<InventoryItem[]>(await call('GET','/seller/inventory',agentToken));
 assert.equal(ok<BusinessJson>(await call('GET','/seller/business',agentToken)).owner_email,owner.email);
 err(await call('PATCH','/seller/business',agentToken,{delivery_cents:0}),'forbidden',403);
 err(await call('POST','/seller/inventory',agentToken,{title:'Desk',category:'desk',list_cents:200,floor_cents:100,available:1}),'forbidden',403);
 const lines=stock.map(i=>({inventory_id:i.inventory_id,quantity:1,unit_cents:i.list_cents!}));
 err(await call('POST',`/sessions/${session}/offers`,agentToken,{expected_version:0,items:lines.map(l=>({...l,unit_cents:100}))},randomUUID()),'below_floor',409);
 offer=ok<CreatedOffer>(await call('POST',`/sessions/${session}/offers`,agentToken,{expected_version:0,items:lines},randomUUID()));
 assert.equal(offer.total_cents,30000+19500+2000);
});

test('a paid order queues a sale notice for the seller, separate from the buyer receipt email row',async()=>{
 await drain();
 const r=ok<ReservationRow>(await call('POST',`/offers/${offer.offer_id}/reservations`,P.buyer.token,{},randomUUID()));
 const rpc=async<T,>(name: string,args: Record<string,unknown>)=>{const {data,error}=await db.database.rpc(name,args);assert.equal(error,null);return data as T;};
 await rpc('commerce_begin_checkout',{p_buyer:r.buyer_id,p_reservation:r.id});
 const stripeSession=`cs_test_${randomUUID().replaceAll('-','')}`;
 await rpc('commerce_bind_checkout',{p_reservation:r.id,p_session:stripeSession,p_url:'https://checkout.stripe.test'});
 const paid=await rpc<{order_id: string}>('commerce_apply_payment',{p_event:`evt_${randomUUID()}`,p_type:'checkout.session.completed',
  p_reservation:r.id,p_session:stripeSession,p_total:r.total_cents,p_currency:'usd',p_paid:true,p_release:false,p_pending:false});
 const events=await drain();
 const sale=events.filter(e=>e.kind==='order.confirmed');
 assert.equal(sale.length,1);
 const [e]=sale;
 assert.deepEqual(e.payload,{order_id:paid.order_id,reservation_id:r.id,request_id:request.request_id,seller_id:shop.seller_id,
  total_cents:offer.total_cents,currency:'usd',title:'Desk and chair from a real shop'});
 assert.deepEqual({...e.route,buyer_id:''},{to_role:'seller',request_id:request.request_id,seller_id:shop.seller_id,buyer_id:'',
  delegated:true,seller_delegated:true});
 assert.ok(!/budget|target|floor|email/.test(JSON.stringify(e)));
 // Already acked by drain(): acking again reports the public kind and is idempotent.
 assert.equal(ok<EventAck>(await call('POST',`/worker/events/${e.id}/ack`,P.worker.token)).kind,'order.confirmed');
 // The receipt email's row is untouched and can't be acked by the worker.
 const [receipt]=await sql<{id: string; delivered_at: Date | null}>(
  "SELECT id,delivered_at FROM commerce_outbox WHERE kind='order.confirmed' AND aggregate_id=$1",[paid.order_id]);
 assert.equal(receipt.delivered_at,null);
 err(await call('POST',`/worker/events/${receipt.id}/ack`,P.worker.token),'event_not_found',404);
 assert.deepEqual(await rpc('commerce_order_email',{p_order:paid.order_id}),{order_id:paid.order_id,reservation_id:r.id,buyer_id:r.buyer_id,
  email:null,delivered:false});
});

test('turning agent negotiation off revokes seller agent tokens and stops minting',async()=>{
 const off=ok<BusinessJson>(await call('PATCH','/seller/business',owner.sellerToken,{delegate_negotiation:false}));
 assert.equal(off.delegate_negotiation,false);
 err(await call('GET','/me',agentToken),'unauthorized',401);
 err(await call('POST',`/worker/sellers/${shop.seller_id}/token`,P.worker.token,{}),'not_delegated',403);
 // The owner's own access is unaffected, and so are the seeded agent seller tokens.
 ok(await call('GET','/seller/business',owner.sellerToken));
 ok(await call('GET','/me',A.sellers[0].token));
 ok(await call('POST','/seller/inventory',owner.sellerToken,{sku:'HV-CHAIR',title:'Ergo mesh chair',category:'chair',
  attributes:{ergonomic:true},list_cents:19500,floor_cents:12000,available:4}));
 await drain();
 const next=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,order('Second desk and chair'),randomUUID()));
 assert.ok(next.sessions.some(s=>s.seller_id===shop.seller_id),'still matches: delegation only decides who negotiates');
 const opened=(await drain()).find(e=>e.kind==='session.opened'&&e.route.seller_id===shop.seller_id);
 assert.equal(opened?.route.seller_delegated,false);
 ok(await call('PATCH','/seller/business',owner.sellerToken,{delegate_negotiation:true}));
 ok<SellerAgentToken>(await call('POST',`/worker/sellers/${shop.seller_id}/token`,P.worker.token,{}));
});

test('anon and authenticated roles cannot run the new functions',async()=>{
 const fns=['commerce_business_json(uuid)','commerce_register_business(uuid,text,text,integer,integer)','commerce_update_business(uuid,jsonb)',
  'commerce_upsert_inventory(uuid,jsonb)','commerce_mint_seller_agent_token(uuid,text,integer)',
  // 0800 (hardening) added the feed version: commerce_worker_events(integer, integer).
  'commerce_worker_events(integer,integer)',
  // 0700 (conversation) replaced the one-argument ack with commerce_ack_event(uuid, jsonb).
  'commerce_ack_event(uuid,jsonb)'];
 for(const role of ['anon','authenticated']) for(const fn of fns) {
  const [{allowed}]=await sql<{allowed: boolean}>('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[role,`public.${fn}`]);
  assert.equal(allowed,false,`${role} ${fn}`);
 }
});

test('the migration applies when businesses already share names, and still refuses new duplicates',async()=>{
 const name=`signup_dup_${process.pid}`;
 await sql(`CREATE DATABASE ${name}`);
 const url=new URL(DATABASE_URL);url.pathname=`/${name}`;
 const fresh=new pg.Pool({connectionString:url.href,max:1});
 try {
  const files=(await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort();
  const apply=async(path: string)=>{await fresh.query(await readFile(path,'utf8'));};
  await apply(fileURLToPath(new URL('./stubs.sql',import.meta.url)));
  for(const f of files.filter(f=>f<'20261018000600')) await apply(migrations+f);
  const [{id}]=(await fresh.query<{id: string}>("INSERT INTO commerce_actors(label,is_demo) VALUES('dup owner',true) RETURNING id")).rows;
  await fresh.query("INSERT INTO commerce_sellers(owner_id,name) VALUES($1,'Integration test seller'),($1,'Integration test seller'),($1,'integration TEST seller ')",[id]);
  for(const f of files.filter(f=>f>='20261018000600')) await apply(migrations+f);
  const {rows:[{count}]}=await fresh.query<{count: number}>("SELECT count(*)::int AS count FROM commerce_sellers WHERE delegate_negotiation AND created_at IS NOT NULL");
  assert.equal(count,3);
  await assert.rejects(fresh.query("SELECT commerce_register_business($1,'Integration Test Seller',null,null,null)",[id]),/business_name_taken/);
  const {rows:[{b}]}=await fresh.query<{b: BusinessJson}>("SELECT commerce_register_business($1,'Brand New Shop',null,null,null) AS b",[id]);
  assert.equal(b.name,'Brand New Shop');
 } finally {
  await fresh.end();
  await sql(`DROP DATABASE ${name}`);
 }
});
