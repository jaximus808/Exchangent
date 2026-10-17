import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CommerceError } from '../src/commerce.ts';
import { Negotiation, buyerView, sellerView, dbError, errorBody, hashToken, statusFor, validateRequirements, NEXT_ACTIONS } from '../src/negotiation.ts';
import type { RolePrincipal } from '../src/types.ts';

const state={request_id:'r',budget_cents:40000,target_cents:36000,buyer_id:'b',request:{budget_cents:40000,target_cents:1,buyer_id:'b'},
 current_offer:{total_cents:46500,items:[{title:'Desk',unit_cents:26000,floor_cents:19000}]},
 history:[{type:'offer',items:[{floor_cents:1}]},{type:'counter',total_cents:36000}],seller:{agent_handle:'bay@inkbox'}};
const keys=(v: unknown)=>JSON.stringify(v).match(/"[a-z_]+":/g)!.map(k=>k.slice(1,-2));
test('buyer view never contains floors; seller view never contains budget or target',()=>{
 const b=buyerView(state),s=sellerView(state);
 assert.ok(!keys(b).includes('floor_cents'));assert.equal(b.budget_cents,40000);assert.equal(b.current_offer.items[0].unit_cents,26000);
 for(const k of ['budget_cents','target_cents','buyer_id']) assert.ok(!keys(s).includes(k));
 assert.equal(s.current_offer.items[0].floor_cents,19000);assert.equal(s.history[1].total_cents,36000);
 assert.ok(!keys(b).includes('agent_handle')&&!keys(s).includes('agent_handle'));
});
test('principal tokens are stored as sha256 hex and resolved by hash',async()=>{
 const token='a'.repeat(64);
 assert.equal(hashToken(token),createHash('sha256').update(token).digest('hex'));assert.match(hashToken(token),/^[0-9a-f]{64}$/);
 const calls: {name: string; args?: Record<string, unknown>}[]=[];
 const n=new Negotiation({demoToken:'legacy-demo-token-123',demoBuyerId:'buyer-1',db:{database:{rpc:async(name,args)=>{
  calls.push({name,args});return {data:args?.p_token_hash===hashToken(token)?{scope:'seller',actor_id:'a',seller_id:'s'}:null,error:null};}}}});
 assert.deepEqual(await n.principal('Bearer legacy-demo-token-123'),{scope:'buyer',actor_id:'buyer-1',seller_id:null,label:'legacy demo buyer'});
 assert.equal((await n.principal(`Bearer ${token}`)).seller_id,'s');
 assert.equal(calls[0].args?.p_token_hash,hashToken(token));assert.ok(!JSON.stringify(calls).includes(token));
 for(const h of [undefined,'','Bearer short','Basic '+token,`Bearer ${'b'.repeat(64)}`])
  await assert.rejects(n.principal(h),(e: CommerceError)=>e.code==='unauthorized'&&e.status===401);
});
test('scope enforcement rejects the wrong role before touching the database',async()=>{
 const n=new Negotiation({db:{database:{rpc:async()=>assert.fail('no rpc expected')}}});
 const seller: RolePrincipal={scope:'seller',actor_id:'a',seller_id:'s'},buyer: RolePrincipal={scope:'buyer',actor_id:'b'},worker: RolePrincipal={scope:'worker',actor_id:'w'};
 await assert.rejects(n.createRequest(seller,'k',{}),(e: CommerceError)=>e.code==='forbidden'&&e.status===403);
 await assert.rejects(n.makeOffer(buyer,'00000000-0000-4000-8000-000000000000','k',{}),/forbidden/);
 await assert.rejects(n.workerEvents(buyer),/forbidden/);await assert.rejects(n.getSession(worker,'x'),/forbidden/);
 await assert.rejects(n.counter(buyer,'00000000-0000-4000-8000-000000000000',undefined,{expected_version:1,total_cents:1}),/idempotency_key_required/);
 await assert.rejects(n.makeOffer(seller,'00000000-0000-4000-8000-000000000000','k',{expected_version:0,items:[{inventory_id:'x',quantity:1,unit_cents:1}]}),
  (e: CommerceError)=>e.code==='invalid_input'&&/inventory_id/.test(e.detail as string));
});
test('only snake_case database codes pass through; SQL text becomes database_error',()=>{
 assert.equal(dbError({message:'below_floor'}).code,'below_floor');assert.equal(dbError({message:'below_floor'}).status,409);
 assert.equal(dbError({message:'session_not_found'}).status,404);
 const e=dbError({message:'duplicate key value violates unique constraint "x"'});assert.equal(e.code,'database_error');assert.equal(e.status,503);
 assert.equal(statusFor('invalid_input'),400);assert.equal(statusFor('stale_offer'),409);
});
test('error envelope carries a next_action for every negotiation code and hides internals',()=>{
 for(const code of ['stale_offer','not_your_turn','session_closed','below_floor','out_of_stock','budget_exceeded',
  'requirements_mismatch','idempotency_conflict','idempotency_key_required','invalid_input','forbidden','unauthorized']) {
  const {body}=errorBody(new CommerceError(code));assert.equal(body.error.code,code);assert.equal(body.error.next_action,NEXT_ACTIONS[code]);
 }
 assert.match(errorBody(new CommerceError('stale_offer')).body.error.next_action,/get_negotiation/);
 const internal=errorBody(new Error('password=secret'));assert.equal(internal.status,500);assert.equal(internal.body.error.code,'operation_failed');
 assert.ok(!JSON.stringify(internal.body).includes('secret'));
 // Existing reservation errors keep their original HTTP status.
 assert.equal(errorBody(new CommerceError('forbidden',409)).status,409);
});
test('requirements validation',()=>{
 assert.doesNotThrow(()=>validateRequirements({region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]}));
 for(const bad of [null,{},{items:[]},{items:[{}]},{items:[{category:'desk',max_width_in:'48'}]},{region:1,items:[{category:'desk'}]}])
  assert.throws(()=>validateRequirements(bad),/invalid_input/);
});
