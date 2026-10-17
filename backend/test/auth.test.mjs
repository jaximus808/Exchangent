import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Auth,authorize,bearer,hashToken} from '../src/auth.mjs';
import {Activity} from '../src/activity.mjs';
import {createApp} from '../src/server.mjs';
const actor=randomUUID(),request=randomUUID(),seller=randomUUID();
const user={kind:'user',actorId:actor};
const delegated={kind:'delegation',actorId:actor,requestId:request,scopes:['request:read']};
function query(data,error=null){return {select(){return this;},eq(){return this;},limit:async()=>({data,error})};}
test('bearer parsing rejects malformed credentials; scopes bind agents to one request',()=>{
 for(const header of [undefined,'Bearer','Basic x','Bearer x y']) assert.throws(()=>bearer(header));
 assert.equal(bearer('Bearer exg_test'),'exg_test');
 assert.doesNotThrow(()=>authorize(delegated,'request:read',{requestId:request}));
 assert.throws(()=>authorize(delegated,'reservation:write',{requestId:request}),/forbidden/);
 assert.throws(()=>authorize(delegated,'request:read',{requestId:randomUUID()}),/forbidden/);
 assert.throws(()=>authorize(delegated,'seller:read',{sellerId:seller}),/forbidden/);
});
test('invalid upstream sessions never create an actor',async()=>{
 let writes=0;
 const auth=new Auth({commerce:{db:{},rpc:async()=>{writes++;}},verifyUser:async()=>null});
 await assert.rejects(auth.authenticate('Bearer forged.jwt.token'),/unauthorized/);assert.equal(writes,0);
});
test('only the verified upstream user ID determines actor identity',async()=>{
 const id=randomUUID();let args;
 const auth=new Auth({commerce:{db:{},rpc:async(_,input)=>{args=input;return actor;}},verifyUser:async()=>({id})});
 const principal=await auth.authenticate('Bearer test-user-token');
 assert.equal(args.p_user,id);assert.equal(principal.actorId,actor);assert.equal(principal.kind,'user');
});
test('expired and revoked delegated tokens fail closed',async()=>{
 for(const grant of [null,{expires_at:'invalid'},{expires_at:new Date(0).toISOString()},
   {expires_at:new Date(Date.now()+60000).toISOString(),revoked_at:new Date().toISOString()}]) {
  const auth=new Auth({commerce:{db:{database:{from:()=>query(grant?[grant]:[])}}},verifyUser:async()=>{throw Error('not used');}});
  await assert.rejects(auth.authenticate('Bearer exg_secret'),/unauthorized/);
 }
});
test('delegation stores a digest and does not grant unrelated scopes',async()=>{
 let stored;
 const commerce={row:async()=>({buyer_id:actor}),db:{database:{from:()=>({insert(rows){stored=rows[0];return {select:async()=>({data:[{id:'grant',scopes:stored.scopes}],error:null})};}})}}};
 const auth=new Auth({commerce});
 const grant=await auth.createDelegation(user,{request_id:request,scopes:['request:read']});
 assert.equal(stored.token_hash,hashToken(grant.token));assert.notEqual(stored.token_hash,grant.token);
 assert.equal(stored.token,undefined);
 await assert.rejects(auth.createDelegation(user,{request_id:request,scopes:['seller:read']}),/invalid_scope/);
 await assert.rejects(auth.createDelegation(delegated,{request_id:request,scopes:['request:read']}),/user_session_required/);
});
test('buyer and seller projections omit private limits and other owners are denied',async()=>{
 let rows={commerce_requests:{id:request,buyer_id:actor,requirements:'Desk',budget_cents:40000,status:'negotiating',currency:'usd'},
  commerce_sellers:{id:seller,owner_id:actor,name:'Demo',enabled:true}};
 const activity=new Activity({row:async(table)=>rows[table],db:{}});activity.list=async()=>[];
 const own=await activity.request(user,request);assert.equal(own.budget_cents,undefined);assert.equal(own.buyer_id,undefined);
 await assert.rejects(activity.request({...user,actorId:randomUUID()},request),/forbidden/);
 await assert.rejects(activity.seller({...user,actorId:randomUUID()},seller),/forbidden/);
 assert.equal((await activity.seller(user,seller)).seller.owner_id,undefined);
});
test('request validation rejects non-integer budgets and agent-created requests',async()=>{
 const activity=new Activity({db:{},rpc:async()=>({id:request})});
 for(const budget of [0,-1,1.25,Infinity,100000001]) await assert.rejects(activity.createRequest(user,{requirements:'desk',budget_cents:budget},'key'),/invalid_input/);
 await assert.rejects(activity.createRequest(delegated,{requirements:'desk',budget_cents:100},'key'),/user_session_required/);
});
test('HTTP uses verified principal, ignores caller-supplied buyer IDs, rejects malformed JSON',async(t)=>{
 let received;
 const commerce={};const auth={authenticate:async()=>user};
 const activity={createRequest:async(principal,input,key)=>{received={principal,input,key};return {id:request};}};
 const server=createApp({commerce,auth,activity});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+'/api/v1/buy-requests',{method:'POST',headers:{'idempotency-key':'request-1'},
  body:JSON.stringify({buyer_id:randomUUID(),requirements:'desk',budget_cents:100})});
 assert.equal(response.status,200);assert.equal(received.principal.actorId,actor);
 const malformed=await fetch(base+'/api/v1/buy-requests',{method:'POST',body:'{bad'});assert.equal(malformed.status,400);
});
