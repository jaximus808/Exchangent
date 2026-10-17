import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createClient} from '@insforge/sdk';
import {fromEnv} from '../src/commerce.ts';
import type {Activity} from '../src/activity.ts';
import {Auth,authFromEnv,hashToken} from '../src/auth.ts';
import type {OfferRow,Row,SellerRow,UserPrincipal} from '../src/types.ts';
const commerce=fromEnv();const auth=authFromEnv(commerce);
const proof: {request_id: string; reservation_id: string; offer_id: string}=JSON.parse(await readFile(new URL('../.local/proof.json',import.meta.url),'utf8'));
// Administrative fixture principals: no upstream user session behind them.
const user={kind:'user',actorId:process.env.DEMO_BUYER_ID} as UserPrincipal;
const base=process.env.AUTH_TEST_URL??'http://127.0.0.1:8787';
async function get(path: string,token?: string) {return fetch(base+path,{headers:token?{authorization:`Bearer ${token}`}:{}});}
// Administrative test fixture setup uses the existing disposable demo actor.
// These tests exercise persisted delegations, not human login or OAuth consent.
test('real InsForge verification rejects forged JWTs and retired demo tokens',async()=>{
 await assert.rejects(auth.authenticate('Bearer forged.jwt.token'),/unauthorized/);
 const old=await get('/api/v1/me',process.env.COMMERCE_DEMO_TOKEN);assert.equal(old.status,401);
 const missing=await get('/api/v1/me');assert.equal(missing.status,401);
});
test('real task delegation reads only its request and cannot reserve or mint credentials',async()=>{
 const grant=await auth.createDelegation(user,{request_id:proof.request_id,scopes:['request:read']});
 try {
  const {data}=await commerce.db.database.from('commerce_delegations').select('token_hash').eq('id',grant.id).limit(1);
  assert.equal(data![0].token_hash,hashToken(grant.token));
  const request=await get(`/api/v1/buy-requests/${proof.request_id}`,grant.token);assert.equal(request.status,200);
  assert.equal(((await request.json()) as {data: Row}).data.budget_cents,undefined);
  const status=await get(`/api/v1/reservations/${proof.reservation_id}`,grant.token);assert.equal(status.status,200);
  assert.equal(((await status.json()) as {data: Awaited<ReturnType<Activity['status']>>}).data.order!.status,'confirmed');
  const other=await get(`/api/v1/buy-requests/${randomUUID()}`,grant.token);assert.equal(other.status,403);
  const write=await fetch(base+`/api/v1/offers/${proof.offer_id}/reservations`,{method:'POST',headers:{authorization:`Bearer ${grant.token}`,'idempotency-key':randomUUID()}});
  assert.equal(write.status,403);
  const mint=await fetch(base+'/api/v1/delegations',{method:'POST',headers:{authorization:`Bearer ${grant.token}`},body:JSON.stringify({request_id:proof.request_id,scopes:['request:read']})});
  assert.equal(mint.status,403);
 } finally {await auth.revoke(user,grant.id);}
 const revoked=await get('/api/v1/me',grant.token);assert.equal(revoked.status,401);
});
test('seller delegation is isolated from buyer requests and budgets',async()=>{
 const offer=await commerce.row<OfferRow>('commerce_offers',proof.offer_id);
 const seller=await commerce.row<SellerRow>('commerce_sellers',offer.seller_id);
 const owner={kind:'user',actorId:seller.owner_id} as UserPrincipal;
 const grant=await auth.createDelegation(owner,{seller_id:seller.id,scopes:['seller:read']});
 try {
  const response=await get(`/api/v1/sellers/${seller.id}/activity`,grant.token);assert.equal(response.status,200);
  const activity=((await response.json()) as {data: {seller: Row; orders: Row[]}}).data;
  assert.equal(activity.seller.owner_id,undefined);assert.ok(activity.orders.some(o=>o.id));
  assert.ok(!JSON.stringify(activity).includes('budget_cents'));
  const other=await get(`/api/v1/sellers/${randomUUID()}/activity`,grant.token);assert.equal(other.status,403);
  const buyer=await get(`/api/v1/buy-requests/${proof.request_id}`,grant.token);assert.equal(buyer.status,403);
 } finally {await auth.revoke(owner,grant.id);}
});
test('anonymous clients cannot mint actors or read delegated credentials',async()=>{
 const anon=createClient({baseUrl:process.env.INSFORGE_URL,anonKey:process.env.INSFORGE_ANON_KEY});
 const rpc=await anon.database.rpc('commerce_actor_for_user',{p_user:randomUUID(),p_label:'forged'});assert.ok(rpc.error);
 const read=await anon.database.from('commerce_delegations').select('id,token_hash').limit(1);assert.ok(read.error);
});
