import test from 'node:test';
import assert from 'node:assert/strict';
import { mintAgentTokens } from '../scripts/agent-tokens.ts';
import { SELLERS, seedId } from '../scripts/seed-negotiation.ts';
import { hashToken } from '../src/negotiation.ts';
import type { Db, Row } from '../src/types.ts';

// In-memory stand-in: records every write; there is no delete or update path to call.
function fakeDb(sellers: Row[],actors: string[]=[]) {
 const writes: {op: string; table?: string; rows?: unknown; name?: string; args?: Record<string, unknown>}[]=[];
 const read=(table: string)=>{
  const filters: [string,unknown][]=[];
  const rows=()=>(table==='commerce_sellers'?sellers:actors.map(id=>({id}))).filter(r=>filters.every(([c,v])=>r[c]===v));
  const q={eq:(c: string,v: unknown)=>{filters.push([c,v]);return q;},order:()=>q,limit:async()=>({data:rows(),error:null}),
   then:(ok: (v: unknown)=>unknown)=>Promise.resolve({data:rows(),error:null}).then(ok)};
  return q;
 };
 const db={database:{
  rpc:async(name: string,args: Record<string, unknown>={})=>{writes.push({op:'rpc',name,args});return {data:{revoked:0,minted:1,expires_at:'t'},error:null};},
  from:(table: string)=>({select:()=>read(table),insert:async(rows: Row[])=>{writes.push({op:'insert',table,rows});return {data:null,error:null};},
   upsert:()=>assert.fail('no upsert'),update:()=>assert.fail('no update'),delete:()=>assert.fail('no delete')}),
 }} as unknown as Db;
 return {db,writes};
}
const demo=SELLERS.map(s=>({id:seedId(`seller:${s.slug}`),name:s.name,owner_id:seedId(`owner:${s.slug}`),enabled:true}));

test('agent tokens: missing demo sellers point at seed:negotiation and write nothing',async()=>{
 const {db,writes}=fakeDb(demo.slice(1));
 await assert.rejects(mintAgentTokens(db),/Demo seller Bay Desk Co not found.*seed:negotiation/);
 assert.equal(writes.length,0);
});
test('agent tokens: hashes only, agents: labels, sellers act as their current owner, actors inserted only if missing',async()=>{
 const {db,writes}=fakeDb([...demo,{...demo[0],id:'00000000-0000-4000-8000-00000000000a',name:'Real Desk',owner_id:'owner-x'}],[seedId('worker')]);
 const {principals}=await mintAgentTokens(db,{sellers:['REAL DESK'],hours:24,baseUrl:'https://api.example.test'});
 assert.deepEqual(writes.filter(w=>w.op==='insert').map(w=>w.rows),[[{id:seedId('buyer-agent'),label:'Exchangent buyer agent',is_demo:true}]]);
 const rpc=writes.find(w=>w.op==='rpc')!;
 assert.equal(rpc.name,'commerce_rotate_agent_principals');assert.equal(rpc.args!.p_hours,24);
 const rows=rpc.args!.p_principals as Row[];
 assert.deepEqual(rows.map(r=>[r.scope,r.label,r.actor_id,r.seller_id]),[
  ['buyer_agent','agents:buyer-agent',seedId('buyer-agent'),null],['worker','agents:worker',seedId('worker'),null],
  ['seller','agents:seller:00000000-0000-4000-8000-00000000000a','owner-x','00000000-0000-4000-8000-00000000000a']]);
 assert.deepEqual(rows.map(r=>r.token_hash),[principals.buyer.token,principals.worker.token,principals.sellers[0].token].map(hashToken));
 assert.ok(!JSON.stringify(writes).includes(principals.buyer.token));
 assert.deepEqual({...principals.buyer,token:'-'},{actor_id:seedId('buyer-agent'),token:'-',scope:'buyer_agent'});
 assert.equal(principals.backend_url,'https://api.example.test');
 await assert.rejects(mintAgentTokens(db,{hours:1.5}),/--hours/);
 await assert.rejects(mintAgentTokens(fakeDb([...demo,{...demo[0],id:'00000000-0000-4000-8000-00000000000b'}]).db,{sellers:['Bay Desk Co']}),/UUID/);
});
