import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CommerceError } from '../src/commerce.ts';
import { Negotiation, NOT_DELEGATED, buyerView, sellerView, dbError, errorBody, hashToken, statusFor, validateRequirements, NEXT_ACTIONS } from '../src/negotiation.ts';
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
test('buyer agent: acts as the delegated request buyer, validates before any lookup, never creates or works',async()=>{
 const S='00000000-0000-4000-8000-000000000001',R='00000000-0000-4000-8000-000000000002';
 const calls: {name: string; args: Record<string, unknown>}[]=[];
 let delegated=true;
 const state={request_id:R,buyer_id:'human',budget_cents:40000,target_cents:36000,delegate_negotiation:true,sessions:[],reservation:null};
 const n=new Negotiation({db:{database:{rpc:async(name,args={})=>{
  calls.push({name,args});
  if(name==='commerce_delegated_buyer') return delegated?{data:{request_id:R,buyer_id:'human'},error:null}:{data:null,error:{message:'forbidden'}};
  if(name==='commerce_request_state') return {data:{...state,delegate_negotiation:delegated},error:null};
  if(name==='commerce_delegated_buyer_email') return {data:{request_id:R,email:'h@example.test'},error:null};
  if(name==='commerce_session_state') return {data:{session_id:S,seller_id:'s',request:{...state,delegate_negotiation:delegated},history:[]},error:null};
  return {data:{ok:true},error:null};
 }}}});
 const agent: RolePrincipal={scope:'buyer_agent',actor_id:'agent',seller_id:null},buyer: RolePrincipal={scope:'buyer',actor_id:'human'};
 await n.counter(agent,S,'k',{expected_version:1,total_cents:36000});
 assert.deepEqual(calls.map(c=>c.name),['commerce_delegated_buyer','commerce_buyer_counter']);
 assert.deepEqual(calls[0].args,{p_request:null,p_session:S});assert.equal(calls[1].args.p_buyer,'human');
 calls.length=0;await n.decline(agent,S,'k',{reason:'no'});
 assert.deepEqual(calls[1],{name:'commerce_decline_session',args:{p_actor:'human',p_scope:'buyer',p_seller:null,p_session:S,p_reason:'no'}});
 // buyer_email only for the buyer agent.
 assert.equal((await n.getRequest(agent,R) as {buyer_email?: string}).buyer_email,'h@example.test');
 calls.length=0;assert.ok(!('buyer_email' in await n.getRequest(buyer,R)));assert.ok(!calls.some(c=>c.name==='commerce_delegated_buyer_email'));
 assert.equal((await n.getSession(agent,S)).role,'buyer');
 // Bad input is rejected before the delegation lookup.
 calls.length=0;
 await assert.rejects(n.counter(agent,S,undefined,{expected_version:1,total_cents:1}),/idempotency_key_required/);
 await assert.rejects(n.counter(agent,'x','k',{expected_version:1,total_cents:1}),/invalid_id/);
 await assert.rejects(n.decline(agent,S,undefined,{}),/idempotency_key_required/);
 assert.equal(calls.length,0);
 // Not delegated: 403 with a hint, on every buyer-side action.
 delegated=false;
 const notDelegated=(e: CommerceError)=>e.code==='forbidden'&&e.status===403&&e.detail===NOT_DELEGATED;
 for(const action of [()=>n.counter(agent,S,'k',{expected_version:1,total_cents:1}),()=>n.decline(agent,S,'k',{}),
  ()=>n.getRequest(agent,R),()=>n.listOffers(agent,R),()=>n.getSession(agent,S)]) await assert.rejects(action(),notDelegated);
 // Everything else is forbidden without touching the database.
 calls.length=0;
 for(const action of [()=>n.createRequest(agent,'k',{}),()=>n.sellerSessions(agent,null),()=>n.sellerInventory(agent),
  ()=>n.makeOffer(agent,S,'k',{}),()=>n.workerEvents(agent),()=>n.ackEvent(agent,S),()=>n.setAgentHandle(agent,S,{agent_handle:'x'})])
  await assert.rejects(action(),(e: CommerceError)=>e.code==='forbidden'&&/buyer_agent/.test(e.detail as string));
 assert.equal(calls.length,0);
 assert.throws(()=>n.need(agent,'buyer'),/forbidden/);
 assert.ok(!keys(sellerView({request:{buyer_email:'h@example.test',title:'t'}})).includes('buyer_email'));
});
test('opening total is the first recorded offer and only loaded after buyer access is checked',async()=>{
 const request='00000000-0000-4000-8000-000000000002',session='00000000-0000-4000-8000-000000000003';
 const calls:string[]=[];
 const n=new Negotiation({db:{database:{rpc:async(name)=>{
  calls.push(name);
  return {error:null,data:name==='commerce_request_state'?{
   request_id:request,buyer_id:'buyer',budget_cents:40000,sessions:[{session_id:session,status:'open',seller_name:'Bay Desk Co',seller:{delivery_days:2},current_offer:{version:2,total_cents:36000,is_current:true}}]
  }:{history:[{type:'offer',total_cents:46500,items:[{floor_cents:19000}]},{type:'counter',total_cents:36000},{type:'offer',total_cents:36000}]}};
 }}}});
 await assert.rejects(n.getRequest({scope:'buyer',actor_id:'other'},request),/forbidden/);
 assert.deepEqual(calls,['commerce_request_state']);
 const data=await n.getRequest({scope:'buyer',actor_id:'buyer'},request);
 assert.equal(data.sessions[0].opening_total_cents,46500);
 assert.ok(!JSON.stringify(data).includes('floor_cents'));
 const offers=await n.listOffers({scope:'buyer',actor_id:'buyer'},request);
 assert.equal(offers[0].opening_total_cents,46500);assert.equal(offers[0].delivery_days,2);
});
test('businesses: buyers register, owners edit, agent tokens only negotiate, the worker mints hashed seller tokens',async()=>{
 const calls: {name: string; args?: Record<string, unknown>}[]=[];
 const n=new Negotiation({db:{database:{rpc:async(name,args)=>{calls.push({name,args});
  return {data:name==='commerce_mint_seller_agent_token'?{seller_id:args?.p_seller,name:'Desk Shop',expires_at:'t',agent_handle:null}
   :{seller_id:'s',name:'Desk Shop'},error:null};}}}});
 const buyer: RolePrincipal={scope:'buyer',actor_id:'b',label:'connector'},owner: RolePrincipal={scope:'seller',actor_id:'b',seller_id:'s',label:'connector'};
 const agent: RolePrincipal={scope:'seller',actor_id:'b',seller_id:'s',label:'agents:seller-agent:s'},worker: RolePrincipal={scope:'worker',actor_id:'w'};
 const r=await n.registerBusiness(buyer,{name:'Desk Shop',delivery_cents:1500});
 assert.equal(r.business.name,'Desk Shop');assert.match(r.next,/choose Desk Shop/);
 assert.deepEqual(calls[0].args,{p_actor:'b',p_name:'Desk Shop',p_service_area:null,p_delivery_cents:1500,p_delivery_days:null});
 for(const p of [owner,worker,{scope:'buyer_agent',actor_id:'x'} as RolePrincipal]) await assert.rejects(n.registerBusiness(p,{name:'X Y'}),/forbidden/);
 await assert.rejects(n.registerBusiness(buyer,{}),/invalid_input/);
 await assert.rejects(n.registerBusiness(buyer,{name:'Shop',delivery_days:31}),/invalid_input/);
 await n.updateBusiness(owner,{delegate_negotiation:false});await n.upsertInventory(owner,{title:'Desk'});
 assert.deepEqual(calls.slice(-2).map(c=>c.name),['commerce_update_business','commerce_upsert_inventory']);
 await assert.rejects(n.updateBusiness(agent,{}),(e: CommerceError)=>e.code==='forbidden'&&e.status===403);
 await assert.rejects(n.upsertInventory(agent,{}),/forbidden/);await assert.rejects(n.updateBusiness(buyer,{}),/forbidden/);
 assert.equal((await n.getBusiness(agent)).seller_id,'s');
 await assert.rejects(n.mintSellerAgentToken(owner,'00000000-0000-4000-8000-000000000000',{}),/forbidden/);
 await assert.rejects(n.mintSellerAgentToken(worker,'00000000-0000-4000-8000-000000000000',{hours:73}),/invalid_input/);
 const minted=await n.mintSellerAgentToken(worker,'00000000-0000-4000-8000-000000000000',{});
 assert.match(minted.token,/^[0-9a-f]{64}$/);
 assert.deepEqual(calls.at(-1)?.args,{p_seller:'00000000-0000-4000-8000-000000000000',p_token_hash:hashToken(minted.token),p_hours:24});
 assert.ok(!JSON.stringify(calls).includes(minted.token));
 assert.equal(statusFor('not_delegated'),403);assert.equal(statusFor('business_name_taken'),409);assert.equal(statusFor('business_limit'),409);
 for(const code of ['business_name_taken','business_limit','not_delegated']) assert.ok(NEXT_ACTIONS[code]);
});
test('ack: optional delivery receipt; a missing two-argument ack (migration not applied) falls back to the plain ack',async()=>{
 const event='00000000-0000-4000-8000-000000000009';
 const calls:{name:string;args:Record<string,unknown>}[]=[];
 let upgraded=false;
 const n=new Negotiation({db:{database:{rpc:async(name,args={})=>{
  calls.push({name,args});
  if('p_delivery' in args&&!upgraded) return {data:null,error:{message:'Could not find the function public.commerce_ack_event(p_delivery, p_event)'}};
  return {data:{id:event,kind:'offer.created',delivered_at:'t'},error:null};
 }}}});
 const worker={scope:'worker' as const,actor_id:'w'};
 await n.ackEvent(worker,event);
 await n.ackEvent(worker,event,{});
 await n.ackEvent(worker,event,{delivery:null});
 assert.deepEqual(calls.map(c=>Object.keys(c.args)),[['p_event'],['p_event'],['p_event']]);
 calls.length=0;
 await n.ackEvent(worker,event,{delivery:{transport:'inkbox',message_id:event}});
 assert.deepEqual(calls.map(c=>Object.keys(c.args).sort()),[['p_delivery','p_event'],['p_event']],'falls back once');
 calls.length=0;upgraded=true;
 await n.ackEvent(worker,event,{delivery:{transport:'inkbox'}});
 assert.deepEqual(calls.map(c=>Object.keys(c.args).sort()),[['p_delivery','p_event']]);
 for(const delivery of ['inkbox',[1],5]) await assert.rejects(n.ackEvent(worker,event,{delivery}),/invalid_input/);
 await assert.rejects(n.ackEvent({scope:'seller',actor_id:'s',seller_id:'x'},event,{}),/forbidden/);
});
test('conversation access: buyers read their own request, sellers only their own session',async()=>{
 const request='00000000-0000-4000-8000-000000000002',session='00000000-0000-4000-8000-000000000003';
 const n=new Negotiation({db:{database:{rpc:async(name)=>({error:null,data:
  name==='commerce_request_state'?{request_id:request,buyer_id:'buyer',delegate_negotiation:true,sessions:[]}
  :name==='commerce_session_conversation'?{session_id:session,seller_id:'bay',messages:[]}
  :{request_id:request,sessions:[{seller_handle:'exchangent-bay',messages:[{kind:'offer',total_cents:1,floor_cents:2}]}]}})}}});
 const c=await n.conversation({scope:'buyer',actor_id:'buyer'},request) as unknown as {sessions:{seller_handle:string;messages:object[]}[]};
 assert.equal(c.sessions[0].seller_handle,'exchangent-bay');
 assert.ok(!JSON.stringify(c).includes('floor_cents'),'buyer view strips floors at any depth');
 await assert.rejects(n.conversation({scope:'buyer',actor_id:'other'},request),/forbidden/);
 await assert.rejects(n.conversation({scope:'seller',actor_id:'s',seller_id:'bay'},request),/forbidden/);
 assert.equal((await n.sellerConversation({scope:'seller',actor_id:'s',seller_id:'bay'},session)).session_id,session);
 await assert.rejects(n.sellerConversation({scope:'seller',actor_id:'s',seller_id:'mission'},session),/forbidden/);
 await assert.rejects(n.sellerConversation({scope:'buyer',actor_id:'buyer'},session),/forbidden/);
});
