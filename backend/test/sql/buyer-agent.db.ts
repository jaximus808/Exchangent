// Real-database checks for the platform buyer agent (migrations/20261018000400_buyer-agent.sql,
// scripts/agent-tokens.ts). Run with `npm run test:db`. Drives the production HTTP app.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import type Stripe from 'stripe';
import { pgDb } from '../../scripts/pg-db.ts';
import { seed, seedId } from '../../scripts/seed-negotiation.ts';
import type { DemoPrincipals } from '../../scripts/seed-negotiation.ts';
import { mintAgentTokens } from '../../scripts/agent-tokens.ts';
import type { AgentPrincipals } from '../../scripts/agent-tokens.ts';
import { Commerce, CommerceError } from '../../src/commerce.ts';
import { NOT_DELEGATED, Negotiation, hashToken } from '../../src/negotiation.ts';
import type { CurrentOffer } from '../../src/negotiation.ts';
import { createApp } from '../../src/server.ts';
import type { AppOptions } from '../../src/server.ts';
import type {
 ApiError, CreatedCounter, CreatedOffer, CreatedRequest, DeclinedSession, RequestState, Row, RolePrincipal, SellerSession,
 SessionState, WorkerEvent,
} from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const DATABASE_URL=process.env.DATABASE_URL;
const db=pgDb(DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
const backendDir=fileURLToPath(new URL('../../',import.meta.url));
const run=promisify(execFile);
let server: ReturnType<typeof createApp>,base: string,P: DemoPrincipals,A: AgentPrincipals;
// A real (signed-up) buyer: an auth user, its actor, and its own buyer token.
const human={userId:randomUUID(),email:'human.buyer@example.test',actorId:'',token:randomBytes(32).toString('hex')};
before(async()=>{
 P=await seed(db);
 A=(await mintAgentTokens(db)).principals;
 await sql('INSERT INTO auth.users(id,email) VALUES($1,$2)',[human.userId,human.email]);
 human.actorId=(await sql<{id: string}>("INSERT INTO commerce_actors(auth_user_id,label) VALUES($1,'Exchangent user') RETURNING id",[human.userId]))[0].id;
 await sql("INSERT INTO commerce_principals(token_hash,actor_id,scope,label) VALUES($1,$2,'buyer','test:human-buyer')",[hashToken(human.token),human.actorId]);
 const commerce=new Commerce({db,stripe:{} as Stripe,webhookSecret:'whsec_unused',baseUrl:'http://127.0.0.1',integrationId:'test'});
 server=createApp({commerce,negotiation:new Negotiation({db}),
  auth:{authenticate:async()=>{throw new CommerceError('unauthorized',401);}} as unknown as AppOptions['auth']});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{server?.close();await db.end();});

interface Reply { status: number; body: {data?: unknown; error?: ApiError} }
async function call(method: string,path: string,token?: string,body?: unknown,key?: string): Promise<Reply> {
 const headers: Record<string,string>={};
 if(token) headers.authorization=`Bearer ${token}`;
 if(key) headers['idempotency-key']=key;
 if(body!==undefined) headers['content-type']='application/json';
 const res=await fetch(base+'/api/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as Reply['body']};
}
const ok=<T=unknown,>(r: Reply)=>{assert.ok(r.body.data!==undefined,JSON.stringify(r.body));return r.body.data as T;};
const err=(r: Reply,code: string,status: number)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));assert.equal(r.status,status);
 assert.ok(r.body.error!.next_action);};
const has=(v: unknown,k: string)=>JSON.stringify(v).includes(`"${k}"`);
const requirements={region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
const order={title:'Desk and ergonomic chair',requirements,budget_cents:40000,target_cents:36000};
const bayLines=[{inventory_id:seedId('inventory:bay-desk-co:BAY-DESK-46'),quantity:1,unit_cents:26000},
 {inventory_id:seedId('inventory:bay-desk-co:BAY-CHAIR-MESH'),quantity:1,unit_cents:18000}];
type SessionView=SessionState&{role: string};

test('platform buyer agent negotiates delegated orders of any buyer, and nothing else',async t=>{
 const agent=A.buyer.token,bay=A.sellers.find(s=>s.name==='Bay Desk Co')!,mission=A.sellers.find(s=>s.name==='Mission Ergonomics')!;
 const delegated=ok<CreatedRequest>(await call('POST','/buy-requests',human.token,order,randomUUID()));
 const privateReq=ok<CreatedRequest>(await call('POST','/buy-requests',human.token,{...order,delegate_negotiation:false},randomUUID()));
 const ds=delegated.sessions.find(s=>s.seller_id===bay.seller_id)!.session_id,dm=delegated.sessions.find(s=>s.seller_id===mission.seller_id)!.session_id;
 const ps=privateReq.sessions.find(s=>s.seller_id===bay.seller_id)!.session_id;
 let offer: CreatedOffer,privateOffer: CreatedOffer;

 await t.test('whoami and agent seller tokens',async()=>{
  assert.deepEqual(ok<RolePrincipal>(await call('GET','/me',agent)),{scope:'buyer_agent',actor_id:seedId('buyer-agent'),seller_id:null,label:'agents:buyer-agent'});
  assert.equal(ok<RolePrincipal>(await call('GET','/me',A.worker.token)).scope,'worker');
  assert.equal(ok<RolePrincipal>(await call('GET','/me',bay.token)).seller_id,bay.seller_id);
  offer=ok<CreatedOffer>(await call('POST',`/sessions/${ds}/offers`,bay.token,{expected_version:0,items:bayLines},randomUUID()));
  privateOffer=ok<CreatedOffer>(await call('POST',`/sessions/${ps}/offers`,bay.token,{expected_version:0,items:bayLines},randomUUID()));
 });

 await t.test('buyer view of a delegated request, with budget and the buyer email',async()=>{
  const r=ok<RequestState&{buyer_email: string | null}>(await call('GET',`/buy-requests/${delegated.request_id}`,agent));
  assert.equal(r.budget_cents,40000);assert.equal(r.target_cents,36000);assert.equal(r.delegate_negotiation,true);
  assert.equal(r.buyer_email,human.email);
  assert.ok(!has(r,'floor_cents')&&!has(r,'buyer_id'));
  // The buyer themselves never gets buyer_email; sellers never see it either.
  assert.ok(!has(ok(await call('GET',`/buy-requests/${delegated.request_id}`,human.token)),'buyer_email'));
  const sellerSessions=ok<SellerSession[]>(await call('GET','/seller/sessions',bay.token));
  const sellerView=ok(await call('GET',`/sessions/${ds}`,bay.token));
  for(const v of [sellerSessions,sellerView]) assert.ok(!has(v,'buyer_email')&&!JSON.stringify(v).includes(human.email)&&!has(v,'budget_cents'));
  const offers=ok<CurrentOffer[]>(await call('GET',`/buy-requests/${delegated.request_id}/offers`,agent));
  assert.deepEqual(offers.map(o=>[o.offer_id,o.session_version,o.within_budget]),[[offer.offer_id,1,false]]);
  assert.ok(!has(offers,'buyer_email')&&!has(offers,'floor_cents'));
  const s=ok<SessionView>(await call('GET',`/sessions/${ds}`,agent));
  assert.equal(s.role,'buyer');assert.equal(s.request.budget_cents,40000);assert.equal(s.turn,'buyer');
  assert.ok(!has(s,'floor_cents')&&!has(s,'buyer_email'));
 });

 await t.test('counter and decline act as the request buyer',async()=>{
  err(await call('POST',`/sessions/${ds}/counters`,agent,{expected_version:1,total_cents:40001},randomUUID()),'budget_exceeded',409);
  err(await call('POST',`/sessions/${ds}/counters`,agent,{expected_version:1,total_cents:36000}),'idempotency_key_required',400);
  const key=randomUUID(),body={expected_version:1,total_cents:36000,note:'Can you do $360 delivered?'};
  const c=ok<CreatedCounter>(await call('POST',`/sessions/${ds}/counters`,agent,body,key));
  assert.equal(c.session_version,2);
  assert.deepEqual(ok(await call('POST',`/sessions/${ds}/counters`,agent,body,key)),c);
  // Same key space as the buyer: the buyer's retry of the agent's key is the same counter.
  assert.deepEqual(ok(await call('POST',`/sessions/${ds}/counters`,human.token,body,key)),c);
  assert.deepEqual(await sql('SELECT buyer_id,total_cents FROM commerce_counters WHERE id=$1',[c.counter_id]),[{buyer_id:human.actorId,total_cents:36000}]);
  err(await call('POST',`/sessions/${ds}/counters`,agent,{...body,expected_version:2},randomUUID()),'not_your_turn',409);
  const d=ok<DeclinedSession>(await call('POST',`/sessions/${dm}/decline`,agent,{reason:'Over budget'},randomUUID()));
  assert.equal(d.status,'declined');
  assert.deepEqual(await sql('SELECT declined_by FROM commerce_sessions WHERE id=$1',[dm]),[{declined_by:'buyer'}]);
 });

 await t.test('a request the buyer did not delegate is forbidden (never 404)',async()=>{
  const forbidden=(r: Reply)=>{err(r,'forbidden',403);assert.equal(r.body.error!.message,NOT_DELEGATED);};
  forbidden(await call('GET',`/buy-requests/${privateReq.request_id}`,agent));
  forbidden(await call('GET',`/buy-requests/${privateReq.request_id}/offers`,agent));
  forbidden(await call('GET',`/sessions/${ps}`,agent));
  forbidden(await call('POST',`/sessions/${ps}/counters`,agent,{expected_version:1,total_cents:36000},randomUUID()));
  forbidden(await call('POST',`/sessions/${ps}/decline`,agent,{},randomUUID()));
  assert.equal((await sql('SELECT status,version FROM commerce_sessions WHERE id=$1',[ps]))[0].status,'open');
  // The buyer still negotiates it themselves.
  assert.equal(ok<RequestState>(await call('GET',`/buy-requests/${privateReq.request_id}`,human.token)).delegate_negotiation,false);
  // Unknown IDs behave exactly as for a buyer.
  err(await call('GET',`/buy-requests/${randomUUID()}`,agent),'request_not_found',404);
  err(await call('POST',`/sessions/${randomUUID()}/counters`,agent,{expected_version:1,total_cents:1},randomUUID()),'session_not_found',404);
  err(await call('GET',`/sessions/${randomUUID()}`,agent),'session_not_found',404);
 });

 await t.test('create, reserve, checkout, seller and worker routes are forbidden',async()=>{
  const before=await sql('SELECT count(*)::int AS n FROM commerce_requests');
  err(await call('POST','/buy-requests',agent,order,randomUUID()),'forbidden',403);
  assert.deepEqual(await sql('SELECT count(*)::int AS n FROM commerce_requests'),before);
  // Role tokens have no list route at all (404 for every role, the buyer agent included).
  err(await call('GET','/buy-requests',agent),'not_found',404);
  err(await call('POST',`/offers/${offer.offer_id}/reservations`,agent,{expected_total_cents:46500},randomUUID()),'forbidden',403);
  err(await call('POST',`/offers/${privateOffer.offer_id}/reservations`,agent,undefined,randomUUID()),'forbidden',403);
  assert.equal((await sql('SELECT count(*)::int AS n FROM commerce_reservations WHERE request_id=$1',[delegated.request_id]))[0].n,0);
  err(await call('POST',`/reservations/${randomUUID()}/checkout`,agent),'forbidden',403);
  err(await call('GET',`/reservations/${randomUUID()}`,agent),'forbidden',403);
  err(await call('GET','/seller/sessions',agent),'forbidden',403);
  err(await call('GET','/seller/inventory',agent),'forbidden',403);
  err(await call('POST',`/sessions/${ds}/offers`,agent,{expected_version:2,items:bayLines},randomUUID()),'forbidden',403);
  err(await call('GET','/worker/events',agent),'forbidden',403);
  err(await call('POST',`/worker/events/${randomUUID()}/ack`,agent),'forbidden',403);
  err(await call('POST',`/worker/sellers/${bay.seller_id}/agent`,agent,{agent_handle:'x'}),'forbidden',403);
  // ...and a buyer token cannot act on the buyer agent's behalf for someone else's request.
  err(await call('GET',`/buy-requests/${delegated.request_id}`,P.buyer.token),'forbidden',403);
 });

 await t.test('worker feed routes carry delegated',async()=>{
  const events: WorkerEvent[]=[];
  for(;;) {
   const page=ok<WorkerEvent[]>(await call('GET','/worker/events?limit=100',A.worker.token));
   if(!page.length) break;
   for(const e of page) {events.push(e);ok(await call('POST',`/worker/events/${e.id}/ack`,A.worker.token));}
  }
  assert.ok(events.every(e=>typeof e.route.delegated==='boolean'));
  const of=(id: string)=>events.filter(e=>e.route.request_id===id);
  assert.deepEqual(of(delegated.request_id).map(e=>[e.kind,e.route.delegated]),[['session.opened',true],['session.opened',true],
   ['offer.created',true],['counter.created',true],['session.declined',true]]);
  assert.deepEqual(of(privateReq.request_id).map(e=>[e.kind,e.route.delegated]),[['session.opened',false],['session.opened',false],['offer.created',false]]);
 });
});

test('agent tokens are additive: seed rows, stock and prices untouched; only agents:% rotate',async()=>{
 const snapshot=()=>sql("SELECT token_hash,revoked_at,expires_at FROM commerce_principals WHERE label LIKE 'seed:%' ORDER BY token_hash");
 const stock=()=>sql('SELECT id,available,sold,floor_cents,list_cents FROM commerce_inventory ORDER BY id');
 const [seedBefore,stockBefore]=[await snapshot(),await stock()];
 const old=A;
 const r=await mintAgentTokens(db,{hours:5,sellers:['bay desk co',seedId('seller:soma-office-supply')]});
 assert.equal(r.revoked,5);
 assert.deepEqual(r.principals.sellers.map(s=>s.name),['Bay Desk Co','SoMa Office Supply']);
 assert.equal(r.principals.backend_url,'http://127.0.0.1:8787');assert.equal(r.principals.buyer.scope,'buyer_agent');
 for(const tok of [old.buyer.token,old.worker.token,...old.sellers.map(s=>s.token)]) err(await call('GET','/me',tok),'unauthorized',401);
 assert.equal(ok<RolePrincipal>(await call('GET','/me',r.principals.buyer.token)).scope,'buyer_agent');
 assert.equal(ok<RolePrincipal>(await call('GET','/me',r.principals.sellers[1].token)).seller_id,seedId('seller:soma-office-supply'));
 const exp=(await sql<{h: number}>('SELECT extract(epoch FROM expires_at-now())/3600 AS h FROM commerce_principals WHERE token_hash=$1',[hashToken(r.principals.worker.token)]))[0].h;
 assert.ok(exp>4.9&&exp<=5,String(exp));
 // The demo seed's principals and inventory are exactly as before.
 assert.deepEqual(await snapshot(),seedBefore);assert.deepEqual(await stock(),stockBefore);
 assert.equal(ok<RolePrincipal>(await call('GET','/me',P.buyer.token)).actor_id,P.buyer.actor_id);
 assert.equal(ok<RolePrincipal>(await call('GET','/me',P.sellers[0].token)).seller_id,P.sellers[0].seller_id);
 assert.equal(ok<RolePrincipal>(await call('GET','/me',P.worker.token)).scope,'worker');
 // Re-seeding leaves agent tokens alone too.
 P=await seed(db);
 assert.equal(ok<RolePrincipal>(await call('GET','/me',r.principals.worker.token)).scope,'worker');
 await assert.rejects(mintAgentTokens(db,{sellers:['No Such Co']}),/No seller named.*seed:negotiation/);
 await assert.rejects(mintAgentTokens(db,{hours:0}),/--hours/);
 // Validation in SQL: only agents:% labels, never seed rows or other scopes.
 for(const bad of [[{token_hash:'a'.repeat(64),actor_id:seedId('worker'),scope:'worker',label:'seed:worker'}],
  [{token_hash:'a'.repeat(64),actor_id:seedId('worker'),scope:'buyer',label:'agents:x'}]])
  assert.equal((await db.database.rpc('commerce_rotate_agent_principals',{p_principals:bad,p_hours:1})).error?.message,'invalid_input');
 // buyer_agent principals carry no seller_id; the scope CHECK still rejects unknown scopes.
 await assert.rejects(sql("INSERT INTO commerce_principals(token_hash,actor_id,scope,seller_id,label) VALUES($1,$2,'buyer_agent',$3,'x')",
  ['b'.repeat(64),seedId('buyer-agent'),P.sellers[0].seller_id]),/check/);
 await assert.rejects(sql("INSERT INTO commerce_principals(token_hash,actor_id,scope,label) VALUES($1,$2,'admin','x')",['c'.repeat(64),seedId('worker')]),/check/);
 A=r.principals;
});

test('agents:tokens CLI writes a 600 principals file and prints no tokens',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'agent-tokens-'));
 try {
  const file=join(dir,'.agent-principals.json');
  const {stdout}=await run(process.execPath,['scripts/agent-tokens.ts','--seller','Mission Ergonomics','--hours','2'],
   {cwd:backendDir,env:{PATH:process.env.PATH??'',DATABASE_URL,AGENT_PRINCIPALS_FILE:file,COMMERCE_BASE_URL:'http://127.0.0.1:9999'}});
  const written=JSON.parse(await readFile(file,'utf8')) as AgentPrincipals;
  assert.equal((await stat(file)).mode&0o777,0o600);
  assert.deepEqual(Object.keys(written).sort(),['backend_url','buyer','sellers','worker']);
  assert.equal(written.backend_url,'http://127.0.0.1:9999');
  assert.deepEqual(written.buyer.actor_id,seedId('buyer-agent'));assert.equal(written.buyer.scope,'buyer_agent');
  assert.deepEqual(written.sellers.map(s=>[s.name,s.seller_id]),[['Mission Ergonomics',seedId('seller:mission-ergonomics')]]);
  for(const tok of [written.buyer.token,written.worker.token,written.sellers[0].token]) {
   assert.match(tok,/^[0-9a-f]{64}$/);assert.ok(!stdout.includes(tok));
  }
  assert.equal(ok<RolePrincipal>(await call('GET','/me',written.buyer.token)).scope,'buyer_agent');
  err(await call('GET','/me',A.buyer.token),'unauthorized',401);
  await assert.rejects(run(process.execPath,['scripts/agent-tokens.ts','--seller','Nope'],
   {cwd:backendDir,env:{PATH:process.env.PATH??'',DATABASE_URL,AGENT_PRINCIPALS_FILE:file}}),/seed:negotiation/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('new functions: project_admin only; the email helper is the only definer and is delegation-bound',async()=>{
 const fns=await sql<{f: string; anon: boolean; auth: boolean; admin: boolean; definer: boolean}>(`SELECT p.proname AS f,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
  has_function_privilege('project_admin',p.oid,'EXECUTE') AS admin, p.prosecdef AS definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('commerce_delegated_buyer','commerce_delegated_buyer_email','commerce_rotate_agent_principals','commerce_worker_events')
  ORDER BY p.proname`);
 assert.deepEqual(fns.map(f=>[f.f,f.anon,f.auth,f.admin,f.definer]),[['commerce_delegated_buyer',false,false,true,false],
  ['commerce_delegated_buyer_email',false,false,true,true],['commerce_rotate_agent_principals',false,false,true,false],
  ['commerce_worker_events',false,false,true,false]]);
 const r=await db.database.rpc('commerce_create_request',{p_buyer:P.buyer.actor_id,p_key:randomUUID(),p_title:'t',p_requirements:requirements,
  p_budget_cents:40000,p_target_cents:null,p_deadline:null,p_delegate:false});
 const id=(r.data as CreatedRequest).request_id;
 assert.equal((await db.database.rpc('commerce_delegated_buyer_email',{p_request:id})).error?.message,'forbidden');
 assert.equal((await db.database.rpc('commerce_delegated_buyer',{p_request:id,p_session:null})).error?.message,'forbidden');
 assert.equal((await db.database.rpc('commerce_delegated_buyer',{p_request:null,p_session:null})).error?.message,'invalid_input');
 // A demo actor has no auth user, so no email.
 const d=(await db.database.rpc('commerce_create_request',{p_buyer:P.buyer.actor_id,p_key:randomUUID(),p_title:'t',p_requirements:requirements,
  p_budget_cents:40000,p_target_cents:null,p_deadline:null,p_delegate:true})).data as CreatedRequest;
 assert.deepEqual((await db.database.rpc('commerce_delegated_buyer_email',{p_request:d.request_id})).data,{request_id:d.request_id,email:null});
 // Leave the shared database's worker feed empty for the next test file.
 await sql("UPDATE commerce_outbox SET delivered_at=now() WHERE delivered_at IS NULL AND kind<>'order.confirmed'");
});
