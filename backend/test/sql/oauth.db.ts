// Real-database checks for connector OAuth (doc/oauth-contract.md). Run with `npm run test:db`.
// Drives the production HTTP app: InsForge user sessions are stubbed at verifyUser only, so
// actor mapping, consent, code redemption, rotation and the negotiation routes are all real.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { Auth, hashToken } from '../../src/auth.ts';
import { Commerce } from '../../src/commerce.ts';
import type { CheckoutLink, ReservationStatusView } from '../../src/commerce.ts';
import { Negotiation } from '../../src/negotiation.ts';
import type { CurrentOffer } from '../../src/negotiation.ts';
import type { ConsentTargets, TokenResponse } from '../../src/oauth.ts';
import { createApp } from '../../src/server.ts';
import type { ApiError, CreatedOffer, CreatedRequest, InventoryItem, ReservationRow, Row, SellerSession } from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const DATABASE_URL=process.env.DATABASE_URL;
const db=pgDb(DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
const backendDir=fileURLToPath(new URL('../../',import.meta.url));
const run=promisify(execFile);
const script=(name: string,args: string[],env: Record<string,string>={})=>run(process.execPath,[`scripts/${name}.ts`,...args],
 {cwd:backendDir,env:{PATH:process.env.PATH??'',DATABASE_URL,...env}});

const CLIENT='exchangent-mcp-dbtest',SECRET=randomBytes(32).toString('base64url');
const CB='https://mcp.example.test/mcp/oauth/callback',LOCAL_CB='http://localhost:3000/mcp/oauth/callback';
const buyerUser={id:randomUUID(),email:'buyer@example.test'},ownerUser={id:randomUUID(),email:'Owner@Example.test'};
const sessions: Record<string,{id: string; email: string}>={'session-buyer':buyerUser,'session-owner':ownerUser};
let server: ReturnType<typeof createApp>,base: string,P: DemoPrincipals;
before(async()=>{
 P=await seed(db);
 await sql('INSERT INTO auth.users(id,email) VALUES($1,$2),($3,$4)',[buyerUser.id,buyerUser.email,ownerUser.id,ownerUser.email]);
 const stripe={checkout:{sessions:{create:async()=>({id:'cs_test_oauth_db',livemode:false,url:'https://checkout.stripe.test/c/pay/cs_test_oauth_db'})}}};
 const commerce=new Commerce({db,stripe:stripe as unknown as Stripe,webhookSecret:'whsec_unused',baseUrl:'http://127.0.0.1',integrationId:'test'});
 const auth=new Auth({commerce,verifyUser:async token=>sessions[token]??null});
 server=createApp({commerce,auth,negotiation:new Negotiation({db})});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{server?.close();await db.end();});

interface Reply { status: number; headers: Headers; body: {data?: unknown; error?: ApiError} }
async function call(method: string,path: string,token?: string,body?: unknown,key?: string): Promise<Reply> {
 const headers: Record<string,string>={};
 if(token) headers.authorization=`Bearer ${token}`;
 if(key) headers['idempotency-key']=key;
 if(body!==undefined) headers['content-type']='application/json';
 const res=await fetch(base+'/api/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,headers:res.headers,body:await res.json() as Reply['body']};
}
const ok=<T=unknown,>(r: Reply)=>{assert.ok(r.body.data!==undefined,JSON.stringify(r.body));return r.body.data as T;};
const err=(r: Reply,code: string,status: number)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));assert.equal(r.status,status);};

interface TokenReply { status: number; headers: Headers; body: Partial<TokenResponse> & {error?: string; error_description?: string} }
/** What the mcp-use proxy sends: client_secret_post in a form body with `;charset=UTF-8`. */
async function token(params: Record<string,string>,{secret=SECRET,client=CLIENT,json=false,basic=false}={}): Promise<TokenReply> {
 const body: Record<string,string>={...params,...(basic?{}:{client_id:client,client_secret:secret})};
 const headers: Record<string,string>={'content-type':json?'application/json':'application/x-www-form-urlencoded;charset=UTF-8'};
 if(basic) headers.authorization='Basic '+Buffer.from(`${client}:${secret}`).toString('base64');
 const res=await fetch(base+'/api/v1/oauth/token',{method:'POST',headers,body:json?JSON.stringify(body):new URLSearchParams(body).toString()});
 return {status:res.status,headers:res.headers,body:await res.json() as TokenReply['body']};
}
const tokenErr=(r: TokenReply,error: string,status=400)=>{assert.equal(r.body.error,error,JSON.stringify(r.body));assert.equal(r.status,status);
 assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(!('access_token' in r.body));};
const pkce=()=>{const verifier=randomBytes(32).toString('base64url');return {verifier,challenge:createHash('sha256').update(verifier).digest('base64url')};};
type Target={kind: 'buyer'} | {kind: 'seller'; seller_id: string};
/** Consent approval as the web server action sends it; returns the code from redirect_to. */
async function approve(session: string,target: Target,{redirect_uri=CB,state='st-'+randomUUID()}={}) {
 const {verifier,challenge}=pkce();
 const r=await call('POST','/oauth/authorize',session,{client_id:CLIENT,redirect_uri,scope:'buyer seller',state,
  code_challenge:challenge,code_challenge_method:'S256',target});
 const url=new URL(ok<{redirect_to: string}>(r).redirect_to);
 assert.equal(url.origin+url.pathname,new URL(redirect_uri).origin+new URL(redirect_uri).pathname);
 assert.deepEqual([...url.searchParams.keys()],['code','state']);assert.equal(url.searchParams.get('state'),state);
 return {code:url.searchParams.get('code')!,verifier,redirect_uri};
}
const exchange=(a: {code: string; verifier: string; redirect_uri: string},opts?: Parameters<typeof token>[1])=>
 token({grant_type:'authorization_code',code:a.code,redirect_uri:a.redirect_uri,code_verifier:a.verifier},opts);
async function connect(session: string,target: Target) {
 const r=await exchange(await approve(session,target));
 assert.equal(r.status,200,JSON.stringify(r.body));
 return r.body as TokenResponse;
}

test('connector OAuth end to end on real Postgres',async t=>{
 const [bay,mission]=P.sellers;
 let buyerActor: string,ownerActor: string,buyer: TokenResponse,seller: TokenResponse;

 await t.test('oauth:client registers from env, never prints or replaces a secret it was not given',async()=>{
  const args=['--name','Exchangent MCP','--redirect-uri',CB,'--redirect-uri',LOCAL_CB];
  const first=await script('oauth-client',args,{EXCHANGENT_OAUTH_CLIENT_ID:CLIENT,EXCHANGENT_OAUTH_CLIENT_SECRET:SECRET});
  assert.ok(!first.stdout.includes(SECRET)&&!first.stderr.includes(SECRET));
  const out=JSON.parse(first.stdout);
  assert.deepEqual([out.client_id,out.name,out.redirect_uris,out.created],[CLIENT,'Exchangent MCP',[CB,LOCAL_CB],true]);
  const [row]=await sql('SELECT secret_hash,redirect_uris FROM commerce_oauth_clients WHERE client_id=$1',[CLIENT]);
  assert.equal(row.secret_hash,hashToken(SECRET));
  // Re-run with only the client ID: secret kept. From an env file holding the same values: no change.
  const keep=JSON.parse((await script('oauth-client',args,{EXCHANGENT_OAUTH_CLIENT_ID:CLIENT})).stdout);
  assert.deepEqual([keep.created,keep.secret_changed,keep.client_secret],[false,false,'(unchanged; not printed)']);
  const dir=await mkdtemp(join(tmpdir(),'exchangent-oauth-'));
  try {
   await writeFile(join(dir,'.env'),`EXCHANGENT_OAUTH_CLIENT_ID=${CLIENT}\nEXCHANGENT_OAUTH_CLIENT_SECRET="${SECRET}"\n`);
   const fromFile=await script('oauth-client',[...args,'--env-file',join(dir,'.env')]);
   assert.equal(JSON.parse(fromFile.stdout).secret_changed,false);assert.ok(!fromFile.stdout.includes(SECRET));
  } finally {await rm(dir,{recursive:true});}
  // A new client without a secret gets one generated and printed exactly once.
  const fresh=JSON.parse((await script('oauth-client',['--name','Other','--redirect-uri',CB])).stdout);
  assert.match(fresh.client_id,/^exchangent-mcp-[0-9a-f]{12}$/);assert.equal(fresh.client_secret.length,43);
  const [other]=await sql('SELECT secret_hash FROM commerce_oauth_clients WHERE client_id=$1',[fresh.client_id]);
  assert.equal(other.secret_hash,hashToken(fresh.client_secret));
  await assert.rejects(script('oauth-client',['--redirect-uri','http://evil.example/cb']),/https/);
 });

 await t.test('assign:seller makes a signed-up person the owner of a business',async()=>{
  const out=(await script('assign-seller',['--email','owner@example.TEST','--seller','Bay Desk Co'])).stdout;
  const result=JSON.parse(out.slice(0,out.lastIndexOf('}')+1));
  assert.deepEqual([result.seller_id,result.changed,result.previous_owner_id],[bay.seller_id,true,seedId('owner:bay-desk-co')]);
  ownerActor=result.actor_id;
  const [row]=await sql('SELECT a.auth_user_id FROM commerce_sellers s JOIN commerce_actors a ON a.id=s.owner_id WHERE s.id=$1',[bay.seller_id]);
  assert.equal(row.auth_user_id,ownerUser.id);
  assert.match((await script('assign-seller',['--email',ownerUser.email,'--seller',bay.seller_id])).stdout,/nothing changed/);
  await assert.rejects(script('assign-seller',['--email','nobody@example.test','--seller','Bay Desk Co']),/user_not_found/);
  await assert.rejects(script('assign-seller',['--email',ownerUser.email,'--seller','No Such Co']),/seller_not_found/);
 });

 await t.test('targets: user session only, exact client and redirect URI, owned businesses',async()=>{
  const q=(client=CLIENT,uri=CB)=>`/oauth/targets?${new URLSearchParams({client_id:client,redirect_uri:uri})}`;
  err(await call('GET',q()),'unauthorized',401);
  err(await call('GET',q(),'session-unknown'),'unauthorized',401);
  err(await call('GET',q(),P.buyer.token),'user_session_required',403);
  const b=ok<ConsentTargets>(await call('GET',q(),'session-buyer'));
  buyerActor=b.account.actor_id;
  assert.deepEqual(b,{client:{client_id:CLIENT,name:'Exchangent MCP'},account:{actor_id:buyerActor,email:buyerUser.email},businesses:[]});
  const o=ok<ConsentTargets>(await call('GET',q(undefined,LOCAL_CB),'session-owner'));
  assert.deepEqual([o.account.actor_id,o.businesses],[ownerActor,[{seller_id:bay.seller_id,name:'Bay Desk Co'}]]);
  err(await call('GET',q('exchangent-unknown'),'session-buyer'),'invalid_client',400);
  for(const uri of [CB+'/','https://evil.example.test/mcp/oauth/callback',CB+'?x=1'])
   err(await call('GET',q(CLIENT,uri),'session-buyer'),'invalid_redirect_uri',400);
  err(await call('GET','/oauth/targets?client_id='+CLIENT,'session-buyer'),'invalid_request',400);
 });

 await t.test('authorize: PKCE required, ownership enforced, redirect has code and state only',async()=>{
  const {challenge}=pkce();
  const body={client_id:CLIENT,redirect_uri:CB,scope:'buyer seller',state:'s',code_challenge:challenge,code_challenge_method:'S256',target:{kind:'buyer'}};
  err(await call('POST','/oauth/authorize',undefined,body),'unauthorized',401);
  err(await call('POST','/oauth/authorize',P.buyer.token,body),'user_session_required',403);
  err(await call('POST','/oauth/authorize','session-buyer',{...body,code_challenge:undefined,code_challenge_method:undefined}),'invalid_request',400);
  err(await call('POST','/oauth/authorize','session-buyer',{...body,code_challenge_method:'plain'}),'invalid_request',400);
  err(await call('POST','/oauth/authorize','session-buyer',{...body,client_id:'exchangent-unknown'}),'invalid_client',400);
  err(await call('POST','/oauth/authorize','session-buyer',{...body,redirect_uri:CB+'x'}),'invalid_redirect_uri',400);
  err(await call('POST','/oauth/authorize','session-buyer',{...body,target:{kind:'seller',seller_id:bay.seller_id}}),'forbidden',403);
  err(await call('POST','/oauth/authorize','session-owner',{...body,target:{kind:'seller',seller_id:mission.seller_id}}),'forbidden',403);
  err(await call('POST','/oauth/authorize','session-owner',{...body,target:{kind:'seller',seller_id:randomUUID()}}),'forbidden',403);
  const a=await approve('session-buyer',{kind:'buyer'});
  const [row]=await sql('SELECT kind,seller_id,actor_id,code_challenge_method,used_at,expires_at-created_at AS ttl FROM commerce_oauth_codes WHERE code_hash=$1',[hashToken(a.code)]);
  assert.deepEqual([row.kind,row.seller_id,row.actor_id,row.code_challenge_method,row.used_at],['buyer',null,buyerActor,'S256',null]);
  assert.equal((row.ttl as {minutes: number}).minutes,5);
  assert.equal((await sql('SELECT count(*)::int AS n FROM commerce_oauth_codes WHERE code_hash=$1',[a.code]))[0].n,0);
 });

 await t.test('token exchange (form + charset, client_secret_post) and /me connector principal',async()=>{
  const r=await exchange(await approve('session-buyer',{kind:'buyer'}));
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('pragma'),'no-cache');
  buyer=r.body as TokenResponse;
  assert.deepEqual(Object.keys(buyer).sort(),['access_token','expires_in','refresh_token','scope','token_type']);
  assert.match(buyer.access_token,/^exc_[A-Za-z0-9_-]{43}$/);assert.match(buyer.refresh_token,/^exr_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([buyer.token_type,buyer.expires_in,buyer.scope],['Bearer',3600,'buyer']);
  assert.deepEqual(ok(await call('GET','/me',buyer.access_token)),{kind:'connector',scope:'buyer',actor_id:buyerActor,seller_id:null,client_id:CLIENT});
  // Only digests are stored.
  const [g]=await sql('SELECT * FROM commerce_connector_grants WHERE access_hash=$1',[hashToken(buyer.access_token)]);
  assert.equal(g.refresh_hash,hashToken(buyer.refresh_token));assert.ok(!JSON.stringify(g).includes(buyer.access_token.slice(4)));
  err(await call('GET','/oauth/targets?client_id=x&redirect_uri=y',buyer.access_token),'user_session_required',403);
  err(await call('GET','/me',buyer.refresh_token),'unauthorized',401);
  // HTTP Basic with a JSON body works too.
  seller=(await exchange(await approve('session-owner',{kind:'seller',seller_id:bay.seller_id}),{basic:true,json:true})).body as TokenResponse;
  assert.equal(seller.scope,'seller');
  assert.deepEqual(ok(await call('GET','/me',seller.access_token)),{kind:'connector',scope:'seller',actor_id:ownerActor,seller_id:bay.seller_id,client_id:CLIENT});
 });

 await t.test('connector tokens drive the buyer and seller negotiation routes',async()=>{
  const requirements={region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
  const order={title:'Desk and chair via Claude',requirements,budget_cents:40000};
  err(await call('POST','/buy-requests',seller.access_token,order,randomUUID()),'forbidden',403);
  err(await call('GET','/seller/inventory',buyer.access_token),'forbidden',403);
  err(await call('GET','/worker/events',buyer.access_token),'forbidden',403);
  const request=ok<CreatedRequest>(await call('POST','/buy-requests',buyer.access_token,order,randomUUID()));
  const [{buyer_id}]=await sql('SELECT buyer_id FROM commerce_requests WHERE id=$1',[request.request_id]);
  assert.equal(buyer_id,buyerActor);
  const bs=request.sessions.find(s=>s.seller_id===bay.seller_id)!.session_id,ms=request.sessions.find(s=>s.seller_id===mission.seller_id)!.session_id;
  assert.ok(ok<SellerSession[]>(await call('GET','/seller/sessions?status=open',seller.access_token)).some(s=>s.session_id===bs));
  assert.equal(ok<InventoryItem[]>(await call('GET','/seller/inventory',seller.access_token)).length,3);
  const items=[{inventory_id:seedId('inventory:bay-desk-co:BAY-DESK-46'),quantity:1,unit_cents:20500},
   {inventory_id:seedId('inventory:bay-desk-co:BAY-CHAIR-MESH'),quantity:1,unit_cents:13000}];
  // Its own business only: another seller's session is forbidden.
  err(await call('POST',`/sessions/${ms}/offers`,seller.access_token,{expected_version:0,items},randomUUID()),'forbidden',403);
  err(await call('GET',`/sessions/${ms}`,seller.access_token),'forbidden',403);
  const offer=ok<CreatedOffer>(await call('POST',`/sessions/${bs}/offers`,seller.access_token,{expected_version:0,items},randomUUID()));
  assert.equal(offer.total_cents,36000);
  const offers=ok<CurrentOffer[]>(await call('GET',`/buy-requests/${request.request_id}/offers`,buyer.access_token));
  assert.deepEqual(offers.map(o=>o.offer_id),[offer.offer_id]);assert.ok(!JSON.stringify(offers).includes('floor_cents'));
  ok(await call('GET',`/buy-requests/${request.request_id}`,buyer.access_token));
  err(await call('GET',`/buy-requests/${request.request_id}`,P.buyer.token),'forbidden',403);
  const held=ok<ReservationRow>(await call('POST',`/offers/${offer.offer_id}/reservations`,buyer.access_token,{expected_total_cents:36000},randomUUID()));
  assert.deepEqual([held.status,held.buyer_id,held.total_cents],['held',buyerActor,36000]);
  const link=ok<CheckoutLink>(await call('POST',`/reservations/${held.id}/checkout`,buyer.access_token));
  assert.equal(link.session_id,'cs_test_oauth_db');
  assert.equal(ok<ReservationStatusView>(await call('GET',`/reservations/${held.id}`,buyer.access_token)).status,'checkout_open');
  err(await call('GET',`/reservations/${held.id}`,P.buyer.token),'forbidden',403);
 });

 await t.test('refresh rotates both tokens; reusing the old refresh token revokes the grant',async()=>{
  const r=await token({grant_type:'refresh_token',refresh_token:buyer.refresh_token});
  assert.equal(r.status,200,JSON.stringify(r.body));
  const next=r.body as TokenResponse;
  assert.notEqual(next.access_token,buyer.access_token);assert.notEqual(next.refresh_token,buyer.refresh_token);
  assert.deepEqual([next.scope,next.expires_in],['buyer',3600]);
  err(await call('GET','/me',buyer.access_token),'unauthorized',401);
  assert.equal(ok<{actor_id: string}>(await call('GET','/me',next.access_token)).actor_id,buyerActor);
  const [g]=await sql('SELECT rotated_from FROM commerce_connector_grants WHERE access_hash=$1',[hashToken(next.access_token)]);
  assert.ok(g.rotated_from);
  // Another client cannot use this refresh token.
  tokenErr(await token({grant_type:'refresh_token',refresh_token:next.refresh_token},{secret:'wrong-secret-value'}),'invalid_client',401);
  tokenErr(await token({grant_type:'refresh_token',refresh_token:buyer.refresh_token}),'invalid_grant');
  err(await call('GET','/me',next.access_token),'unauthorized',401);
  tokenErr(await token({grant_type:'refresh_token',refresh_token:next.refresh_token}),'invalid_grant');
  const revoked=await sql('SELECT count(*)::int AS n, count(revoked_at)::int AS r FROM commerce_connector_grants WHERE family_id=(SELECT family_id FROM commerce_connector_grants WHERE access_hash=$1)',[hashToken(next.access_token)]);
  assert.deepEqual(revoked[0],{n:2,r:2});
  // Concurrent refreshes with one token: exactly one succeeds.
  const fresh=await connect('session-buyer',{kind:'buyer'});
  const racing=await Promise.all([1,2,3].map(()=>token({grant_type:'refresh_token',refresh_token:fresh.refresh_token})));
  assert.ok(racing.filter(x=>x.status===200).length<=1);assert.ok(racing.some(x=>x.body.error==='invalid_grant'));
 });

 await t.test('code failures: expired, used, wrong verifier, wrong redirect_uri, wrong client',async()=>{
  const expired=await approve('session-buyer',{kind:'buyer'});
  await sql("UPDATE commerce_oauth_codes SET expires_at=now()-interval '1 second' WHERE code_hash=$1",[hashToken(expired.code)]);
  tokenErr(await exchange(expired),'invalid_grant');

  const used=await approve('session-buyer',{kind:'buyer'});
  const first=(await exchange(used)).body as TokenResponse;
  assert.equal(ok<{scope: string}>(await call('GET','/me',first.access_token)).scope,'buyer');
  tokenErr(await exchange(used),'invalid_grant');
  // RFC 6749 section 4.1.2: a replayed code revokes what it issued.
  err(await call('GET','/me',first.access_token),'unauthorized',401);
  tokenErr(await token({grant_type:'refresh_token',refresh_token:first.refresh_token}),'invalid_grant');

  const pk=await approve('session-buyer',{kind:'buyer'});
  tokenErr(await exchange({...pk,verifier:pkce().verifier}),'invalid_grant');
  tokenErr(await exchange({...pk,verifier:'short'}),'invalid_grant');
  tokenErr(await token({grant_type:'authorization_code',code:pk.code,redirect_uri:pk.redirect_uri}),'invalid_request');
  tokenErr(await exchange({...pk,redirect_uri:LOCAL_CB}),'invalid_grant');
  tokenErr(await exchange(pk,{secret:'not-the-secret-at-all-0000000000'}),'invalid_client',401);
  tokenErr(await exchange(pk,{client:'exchangent-unknown'}),'invalid_client',401);
  // Failed attempts do not burn the code: the legitimate client still redeems it.
  assert.equal((await exchange(pk)).status,200);
  tokenErr(await token({grant_type:'password',username:'x'}),'unsupported_grant_type');
  tokenErr(await token({code:'x'}),'invalid_request');

  const race=await approve('session-buyer',{kind:'buyer'});
  const results=await Promise.all([1,2,3].map(()=>exchange(race)));
  assert.ok(results.filter(x=>x.status===200).length<=1);
  assert.equal(results.filter(x=>x.body.error==='invalid_grant').length>=2,true);
  assert.equal((await sql('SELECT count(*)::int AS n FROM commerce_connector_grants WHERE code_hash=$1',[hashToken(race.code)]))[0].n,
   results.filter(x=>x.status===200).length);
 });

 await t.test('expired access tokens and lost business ownership fail closed',async()=>{
  const b=await connect('session-buyer',{kind:'buyer'});
  await sql("UPDATE commerce_connector_grants SET access_expires_at=now()-interval '1 second' WHERE access_hash=$1",[hashToken(b.access_token)]);
  err(await call('GET','/me',b.access_token),'unauthorized',401);
  assert.equal((await token({grant_type:'refresh_token',refresh_token:b.refresh_token})).status,200);
  assert.equal(ok<{scope: string}>(await call('GET','/me',seller.access_token)).scope,'seller');
  await sql('UPDATE commerce_sellers SET owner_id=$1 WHERE id=$2',[seedId('owner:bay-desk-co'),bay.seller_id]);
  err(await call('GET','/me',seller.access_token),'unauthorized',401);
  tokenErr(await token({grant_type:'refresh_token',refresh_token:seller.refresh_token}),'invalid_grant');
  await sql('UPDATE commerce_sellers SET owner_id=$1 WHERE id=$2',[ownerActor,bay.seller_id]);
  err(await call('GET','/me',seller.access_token),'unauthorized',401); // the family stays revoked
  await sql('UPDATE commerce_oauth_clients SET revoked_at=now() WHERE client_id=$1',[CLIENT]);
  err(await call('GET',`/oauth/targets?client_id=${CLIENT}&redirect_uri=${encodeURIComponent(CB)}`,'session-owner'),'invalid_client',400);
  tokenErr(await token({grant_type:'refresh_token',refresh_token:b.refresh_token}),'invalid_client',401);
  await sql('UPDATE commerce_oauth_clients SET revoked_at=NULL WHERE client_id=$1',[CLIENT]);
 });
});

test('anon and authenticated roles cannot touch OAuth tables or functions',async()=>{
 const tables=['commerce_oauth_clients','commerce_oauth_codes','commerce_connector_grants'];
 const rows=await sql<{priv: boolean}>(`SELECT has_table_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,DELETE') AS priv
  FROM unnest(ARRAY['anon','authenticated']) r CROSS JOIN unnest($1::text[]) t`,[tables]);
 assert.ok(rows.length===6&&rows.every(r=>r.priv===false));
 assert.equal((await sql('SELECT relname FROM pg_class WHERE relname=ANY($1) AND relrowsecurity',[tables])).length,3);
 const fns=await sql<{f: string; anon: boolean; auth: boolean; admin: boolean; definer: boolean}>(`SELECT p.oid::regprocedure::text AS f,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon, has_function_privilege('authenticated',p.oid,'EXECUTE') AS auth,
  has_function_privilege('project_admin',p.oid,'EXECUTE') AS admin, p.prosecdef AS definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND (p.proname LIKE 'commerce_oauth_%' OR p.proname IN ('commerce_resolve_connector','commerce_auth_user_by_email','commerce_assign_seller'))`);
 assert.equal(fns.length,8);
 for(const f of fns) assert.deepEqual([f.anon,f.auth,f.admin],[false,false,true],f.f);
 // Only the auth.users email lookup runs with elevated rights.
 assert.deepEqual(fns.filter(f=>f.definer).map(f=>f.f),['commerce_auth_user_by_email(text)']);
});
