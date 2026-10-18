// Real-database checks for agent conversation visibility (migrations/20261018000700_conversation.sql,
// doc/conversation-contract.md). Run with `npm run test:db`. Drives the production HTTP app: delivery
// receipts on acks, the buyer's conversation (role token and web user session), the seller's view of its
// own session, and the web dashboard's business routes (a stubbed InsForge user session).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import type Stripe from 'stripe';
import { pgDb } from '../../scripts/pg-db.ts';
import { seed } from '../../scripts/seed-negotiation.ts';
import type { DemoPrincipals } from '../../scripts/seed-negotiation.ts';
import { mintAgentTokens } from '../../scripts/agent-tokens.ts';
import type { AgentPrincipals } from '../../scripts/agent-tokens.ts';
import { Commerce, CommerceError } from '../../src/commerce.ts';
import { Negotiation } from '../../src/negotiation.ts';
import { createApp } from '../../src/server.ts';
import type { AppOptions } from '../../src/server.ts';
import type {
 ApiError, BusinessJson, BusinessSession, BuyerRequestSummary, Conversation, CreatedCounter, CreatedOffer, CreatedRequest, EventAck,
 InventoryItem, OwnedBusiness, Row, SessionConversation, WorkerEvent,
} from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const db=pgDb(process.env.DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
const BUYER_SESSION='Bearer user-session-buyer',OWNER_SESSION='Bearer user-session-owner';
const owner={userId:randomUUID(),email:'Owner.Conversation@example.test',actorId:''};
let server: ReturnType<typeof createApp>,base: string,P: DemoPrincipals,A: AgentPrincipals,shop: BusinessJson;
before(async()=>{
 P=await seed(db);
 A=(await mintAgentTokens(db)).principals;
 await sql('INSERT INTO auth.users(id,email) VALUES($1,$2)',[owner.userId,owner.email]);
 owner.actorId=(await sql<{id: string}>("INSERT INTO commerce_actors(auth_user_id,label) VALUES($1,'Exchangent user') RETURNING id",[owner.userId]))[0].id;
 const commerce=new Commerce({db,stripe:{} as Stripe,webhookSecret:'whsec_unused',baseUrl:'http://127.0.0.1',integrationId:'test'});
 // Stand-ins for verified InsForge user sessions: the seeded demo buyer and a business owner.
 const auth={authenticate:async(header?: string)=>{
  if(header===BUYER_SESSION) return {kind:'user',actorId:P.buyer.actor_id,userId:randomUUID()};
  if(header===OWNER_SESSION) return {kind:'user',actorId:owner.actorId,userId:owner.userId,email:owner.email};
  throw new CommerceError('unauthorized',401);
 }} as unknown as AppOptions['auth'];
 server=createApp({commerce,negotiation:new Negotiation({db}),auth});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
// Leave the shared test database as other files expect it: this file's business never matches their
// orders, and no event of ours stays pending in the worker feed.
after(async()=>{
 if(shop) await sql('UPDATE commerce_sellers SET enabled=false WHERE id=$1',[shop.seller_id]);
 await sql("UPDATE commerce_outbox SET delivered_at=now() WHERE delivered_at IS NULL AND kind<>'order.confirmed'");
 server?.close();await db.end();
});

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
const err=(r: Reply,code: string,status: number)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));assert.equal(r.status,status);};
const requirements={region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
const inv=async(seller: string,sku: string)=>(await sql<{id: string}>('SELECT id FROM commerce_inventory WHERE seller_id=$1 AND sku=$2',[seller,sku]))[0].id;
const field=(e: WorkerEvent,k: string)=>(e.payload as unknown as Record<string,unknown>)[k];
const receipt=(e: WorkerEvent,from: string,to: string)=>({transport:'inkbox',from_handle:from,to_handle:to,message_id:e.id,
 context_id:`ctx-${field(e,'session_id')}`,delivered_at:'2026-10-18T04:00:00.000Z'});
/** Ack every pending event; acks for this request's events carry an Inkbox receipt. */
async function deliver(requestId: string) {
 for(;;) {
  const page=ok<WorkerEvent[]>(await call('GET','/worker/events?limit=100',P.worker.token));
  if(!page.length) return;
  for(const e of page) {
   const seller=e.route.seller_id===bay.seller_id?'exchangent-bay-desk-co':'exchangent-other';
   const mine=e.route.request_id===requestId;
   const delivery=!mine?undefined:e.route.to_role==='seller'?receipt(e,'exchangent-buyer',seller):receipt(e,seller,'exchangent-buyer');
   ok<EventAck>(await call('POST',`/worker/events/${e.id}/ack`,P.worker.token,delivery?{delivery}:undefined));
  }
 }
}
let bay: DemoPrincipals['sellers'][number],request: CreatedRequest,bs: string,first: CreatedOffer,counter: CreatedCounter,second: CreatedOffer;

test('ack receipts: allowlisted string keys only, first receipt wins, bad receipts rejected',async()=>{
 bay=P.sellers.find(s=>s.name==='Bay Desk Co')!;
 await deliver('none');
 request=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,
  {title:'Watched desk and chair',requirements,budget_cents:50000,target_cents:30000},randomUUID()));
 bs=request.sessions.find(s=>s.seller_id===bay.seller_id)!.session_id;
 const [opened]=ok<WorkerEvent[]>(await call('GET','/worker/events?limit=100',P.worker.token)).filter(e=>field(e,'session_id')===bs);
 for(const delivery of [{transport:'smtp'},{message_id:42},{message_id:'x'.repeat(201)},'inkbox',[1]])
  err(await call('POST',`/worker/events/${opened.id}/ack`,P.worker.token,{delivery}),'invalid_input',400);
 ok(await call('POST',`/worker/events/${opened.id}/ack`,P.worker.token,
  {delivery:{...receipt(opened,'exchangent-buyer','exchangent-bay-desk-co'),secret:'dropped'}}));
 ok(await call('POST',`/worker/events/${opened.id}/ack`,P.worker.token,{delivery:{transport:'local',message_id:'later'}}));
 const [{delivery}]=await sql<{delivery: Record<string,string>}>('SELECT delivery FROM commerce_outbox WHERE id=$1',[opened.id]);
 assert.deepEqual(delivery,receipt(opened,'exchangent-buyer','exchangent-bay-desk-co'),'unknown keys dropped; a retried ack keeps the first receipt');
 // A plain ack (no body, empty body, null delivery) still works.
 const others=ok<WorkerEvent[]>(await call('GET','/worker/events?limit=100',P.worker.token)).filter(e=>field(e,'request_id')===request.request_id);
 assert.ok(others.length>=1);
 ok(await call('POST',`/worker/events/${others[0].id}/ack`,P.worker.token));
 if(others[1]) ok(await call('POST',`/worker/events/${others[1].id}/ack`,P.worker.token,{delivery:null}));
 err(await call('POST',`/worker/events/${opened.id}/ack`,bay.token,{}),'forbidden',403);
});

test('the buyer sees every seller\'s moves with their Inkbox hops and no private numbers',async()=>{
 const lines=(desk: number,chair: number)=>[{inventory_id:'',quantity:1,unit_cents:desk,sku:'BAY-DESK-46'},{inventory_id:'',quantity:1,unit_cents:chair,sku:'BAY-CHAIR-MESH'}];
 const items=async(desk: number,chair: number)=>Promise.all(lines(desk,chair).map(async({sku,...l})=>({...l,inventory_id:await inv(bay.seller_id,sku)})));
 first=ok<CreatedOffer>(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:0,items:await items(26000,18000),note:'Opening at list.'},randomUUID()));
 await deliver(request.request_id);
 counter=ok<CreatedCounter>(await call('POST',`/sessions/${bs}/counters`,A.buyer.token,{expected_version:first.session_version,total_cents:30000,note:'Can you do $300?'},randomUUID()));
 await deliver(request.request_id);
 second=ok<CreatedOffer>(await call('POST',`/sessions/${bs}/offers`,bay.token,{expected_version:counter.session_version,items:await items(21000,14000),note:'Meet in the middle.'},randomUUID()));
 // The last move is not delivered yet: it has no receipt.

 const c=ok<Conversation>(await call('GET',`/buy-requests/${request.request_id}/conversation`,P.buyer.token));
 assert.equal(c.request_id,request.request_id);assert.equal(c.title,'Watched desk and chair');assert.equal(c.status,'negotiating');
 assert.equal(c.delegate_negotiation,true);
 assert.deepEqual(c.sessions.map(s=>s.seller_name),[...c.sessions.map(s=>s.seller_name)].sort());
 const s=c.sessions.find(x=>x.session_id===bs)!;
 assert.equal(s.seller_agent,true);assert.equal(s.turn,'buyer');assert.equal(s.status,'open');
 assert.deepEqual(s.messages.map(m=>[m.kind,m.by,m.total_cents??null,m.note??null]),[
  ['opened','platform',null,null],['offer','seller',first.total_cents,'Opening at list.'],['counter','buyer',30000,'Can you do $300?'],
  ['offer','seller',second.total_cents,'Meet in the middle.']]);
 assert.deepEqual(s.messages[0].delivery,{transport:'inkbox',from_handle:'exchangent-buyer',to_handle:'exchangent-bay-desk-co',
  message_id:s.messages[0].delivery!.message_id,context_id:`ctx-${bs}`,delivered_at:'2026-10-18T04:00:00.000Z'});
 assert.equal(s.messages[1].delivery?.from_handle,'exchangent-bay-desk-co');assert.equal(s.messages[1].delivery?.to_handle,'exchangent-buyer');
 assert.equal(s.messages[1].offer_id,first.offer_id);assert.equal(s.messages[2].counter_id,counter.counter_id);
 assert.equal(s.messages[2].delivery?.to_handle,'exchangent-bay-desk-co');
 assert.equal(s.messages[3].delivery,undefined,'not delivered yet');
 assert.deepEqual(s.current_offer&&{...s.current_offer,expires_at:''},{offer_id:second.offer_id,total_cents:second.total_cents,expires_at:''});
 assert.ok(c.best_offer&&c.best_offer.total_cents<=second.total_cents);
 assert.equal(c.reservation,null);
 const raw=JSON.stringify(c);
 for(const secret of ['floor_cents','budget_cents','target_cents','buyer_email','buyer_id','items','idempotency_key'])
  assert.ok(!raw.includes(secret),`conversation leaks ${secret}`);

 // Same JSON for the buyer agent (delegated) and for the buyer's web session; nobody else.
 assert.deepEqual(ok(await call('GET',`/buy-requests/${request.request_id}/conversation`,A.buyer.token)),c);
 assert.deepEqual(ok(await call('GET',`/buy-requests/${request.request_id}/conversation`,BUYER_SESSION)),c);
 err(await call('GET',`/buy-requests/${request.request_id}/conversation`,OWNER_SESSION),'forbidden',403);
 err(await call('GET',`/buy-requests/${request.request_id}/conversation`,bay.token),'forbidden',403);
 err(await call('GET',`/buy-requests/${randomUUID()}/conversation`,P.buyer.token),'request_not_found',404);
 const privateReq=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,
  {title:'Private haggle',requirements,budget_cents:50000,delegate_negotiation:false},randomUUID()));
 err(await call('GET',`/buy-requests/${privateReq.request_id}/conversation`,A.buyer.token),'forbidden',403);
});

test('the seller sees only its own session, and a decline closes the thread',async()=>{
 const mine=ok<SessionConversation>(await call('GET',`/seller/sessions/${bs}/conversation`,bay.token));
 assert.equal(mine.session_id,bs);assert.equal(mine.seller_name,'Bay Desk Co');
 assert.deepEqual(mine.messages.map(m=>m.kind),['opened','offer','counter','offer']);
 assert.equal(mine.messages[2].note,'Can you do $300?');
 const other=P.sellers.find(s=>s.name!=='Bay Desk Co'&&request.sessions.some(x=>x.seller_id===s.seller_id))!;
 err(await call('GET',`/seller/sessions/${bs}/conversation`,other.token),'forbidden',403);
 err(await call('GET',`/seller/sessions/${bs}/conversation`,P.buyer.token),'forbidden',403);
 err(await call('GET',`/seller/sessions/${randomUUID()}/conversation`,bay.token),'session_not_found',404);
 for(const secret of ['budget_cents','target_cents','buyer_id','buyer_email']) assert.ok(!JSON.stringify(mine).includes(secret));

 ok(await call('POST',`/sessions/${bs}/decline`,A.buyer.token,{reason:'Found a better deal.'},randomUUID()));
 const c=ok<Conversation>(await call('GET',`/buy-requests/${request.request_id}/conversation`,P.buyer.token));
 const s=c.sessions.find(x=>x.session_id===bs)!;
 assert.equal(s.status,'declined');assert.equal(s.current_offer,null);
 assert.deepEqual(s.messages.at(-1) && {kind:s.messages.at(-1)!.kind,by:s.messages.at(-1)!.by,reason:s.messages.at(-1)!.reason},
  {kind:'declined',by:'buyer',reason:'Found a better deal.'});
});

test('the buyer dashboard list: title, sellers, best current offer, still the original fields',async()=>{
 const list=ok<BuyerRequestSummary[]>(await call('GET','/buy-requests',BUYER_SESSION));
 const row=list.find(r=>r.id===request.request_id)!;
 assert.ok(row,'own request listed');
 assert.equal(row.request_id,row.id);assert.equal(row.title,'Watched desk and chair');assert.equal(row.status,'negotiating');
 assert.equal(row.currency,'usd');assert.ok(row.created_at);assert.equal(typeof row.requirements,'string');
 assert.equal(row.delegate_negotiation,true);assert.equal(row.seller_count,request.sessions.length);
 assert.equal(row.open_sessions,request.sessions.length-1,'Bay declined');
 assert.equal(row.budget_cents,50000);assert.equal(row.reservation,null);
 assert.ok(row.best_offer===null||row.best_offer.seller_name!=='Bay Desk Co');
 assert.ok(!JSON.stringify(row).includes('floor_cents'));
 assert.ok(list.every((r,i)=>i===0||r.created_at<=list[i-1].created_at),'newest first');
 assert.ok(!list.some(r=>r.title==='Not mine'));
 err(await call('GET','/buy-requests',undefined),'unauthorized',401);
});

test('web dashboard businesses: owner-only list, sessions, settings and stock',async()=>{
 shop=ok<BusinessJson>(await call('POST','/businesses',OWNER_SESSION,{name:'Conversation Test Desks',delivery_cents:1000,delivery_days:1}));
 const desk=ok<InventoryItem>(await call('POST',`/businesses/${shop.seller_id}/inventory`,OWNER_SESSION,
  {title:'Oak desk 44in',category:'desk',attributes:{width_in:44},list_cents:25000,floor_cents:16000,available:2}));
 assert.equal(desk.floor_cents,16000);
 ok(await call('POST',`/businesses/${shop.seller_id}/inventory`,OWNER_SESSION,
  {sku:'CT-CHAIR',title:'Mesh chair',category:'chair',attributes:{ergonomic:true},list_cents:20000,floor_cents:12000,available:2}));
 err(await call('POST',`/businesses/${shop.seller_id}/inventory`,OWNER_SESSION,{title:'Bad',category:'desk',list_cents:1,floor_cents:2,available:1}),'invalid_input',400);
 const patched=ok<BusinessJson>(await call('PATCH',`/businesses/${shop.seller_id}`,OWNER_SESSION,{delivery_cents:1500,delegate_negotiation:false}));
 assert.equal(patched.delivery_cents,1500);assert.equal(patched.delegate_negotiation,false);
 err(await call('PATCH',`/businesses/${shop.seller_id}`,OWNER_SESSION,{enabled:false}),'invalid_input',400);
 ok(await call('PATCH',`/businesses/${shop.seller_id}`,OWNER_SESSION,{delegate_negotiation:true}));

 const list=ok<OwnedBusiness[]>(await call('GET','/businesses',OWNER_SESSION));
 assert.deepEqual(list.map(b=>b.seller_id),[shop.seller_id]);
 assert.equal(list[0].owner_email,owner.email);assert.equal(list[0].inventory.length,2);
 assert.equal(list[0].open_sessions,0);assert.equal(list[0].orders,0);assert.equal(list[0].sales_cents,0);
 assert.deepEqual(ok(await call('GET','/businesses',BUYER_SESSION)),[],'the demo buyer owns nothing here');

 const req=ok<CreatedRequest>(await call('POST','/buy-requests',P.buyer.token,
  {title:'Desk for the dashboard',requirements,budget_cents:50000,target_cents:30000},randomUUID()));
 assert.ok(req.sessions.some(s=>s.seller_id===shop.seller_id));
 const sessions=ok<BusinessSession[]>(await call('GET',`/businesses/${shop.seller_id}/sessions`,OWNER_SESSION));
 assert.equal(sessions.length,1);
 assert.equal(sessions[0].request.title,'Desk for the dashboard');assert.equal(sessions[0].seller_id,shop.seller_id);
 assert.deepEqual(sessions[0].messages.map(m=>m.kind),['opened']);
 const raw=JSON.stringify(sessions);
 for(const secret of ['budget_cents','target_cents','buyer_id','buyer_email']) assert.ok(!raw.includes(secret),`seller view leaks ${secret}`);
 assert.equal(ok<OwnedBusiness[]>(await call('GET','/businesses',OWNER_SESSION))[0].open_sessions,1);

 // Owner only: another person, a delegation-free role token, bad IDs.
 err(await call('GET',`/businesses/${shop.seller_id}/sessions`,BUYER_SESSION),'forbidden',403);
 err(await call('PATCH',`/businesses/${shop.seller_id}`,BUYER_SESSION,{delivery_cents:1}),'forbidden',403);
 err(await call('POST',`/businesses/${shop.seller_id}/inventory`,BUYER_SESSION,{title:'x',category:'desk',list_cents:2,floor_cents:1,available:1}),'forbidden',403);
 err(await call('GET',`/businesses/${bay.seller_id}/sessions`,OWNER_SESSION),'forbidden',403);
 err(await call('GET','/businesses/not-a-uuid/sessions',OWNER_SESSION),'invalid_id',400);
 err(await call('GET',`/businesses/${randomUUID()}/sessions`,OWNER_SESSION),'not_found',404);
 err(await call('GET','/businesses',undefined),'unauthorized',401);
 // A role token never reaches the user-session business routes.
 err(await call('GET','/businesses',P.buyer.token),'not_found',404);
});

test('anon and authenticated roles cannot run the conversation functions',async()=>{
 const fns=['commerce_ack_event(uuid,jsonb)','commerce_session_messages(uuid)','commerce_session_conversation(uuid)',
  'commerce_conversation(uuid)','commerce_buyer_requests(uuid)','commerce_actor_businesses(uuid)','commerce_business_sessions(uuid)'];
 for(const role of ['anon','authenticated']) for(const fn of fns) {
  const [{allowed}]=await sql<{allowed: boolean}>("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",[role,`public.${fn}`]);
  assert.equal(allowed,false,`${role} ${fn}`);
 }
 assert.equal((await sql("SELECT 1 FROM pg_proc WHERE proname='commerce_ack_event'")).length,1,'one ack function, no overload');
});
