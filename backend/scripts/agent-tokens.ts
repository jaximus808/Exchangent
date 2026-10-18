// Tokens for the agent runner: one platform buyer agent (scope buyer_agent), one worker and one
// seller token per business. Additive: it never resets stock or prices and never touches the
// demo seed's `seed:%` principals. Each run revokes only earlier `agents:%` principals.
// Writes backend/.agent-principals.json (gitignored, mode 600). Only sha256(token) is stored.
//   npm run agents:tokens                                   (the three seeded demo sellers)
//   npm run agents:tokens -- --seller "Bay Desk Co" --seller <seller uuid> --hours 24
//   InsForge: INSFORGE_URL + INSFORGE_API_KEY (backend/.env.local). Local Postgres: DATABASE_URL.
import { randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hashToken } from '../src/negotiation.ts';
import type { Db } from '../src/types.ts';
import { SELLERS, seedId } from './seed-negotiation.ts';
import { parseArgs, scriptDb } from './script-db.ts';

/** Shape of backend/.agent-principals.json (read by agents/src/config.ts). */
export interface AgentPrincipals {
 backend_url: string;
 buyer: { actor_id: string; token: string; scope: 'buyer_agent' };
 sellers: { seller_id: string; name: string; token: string }[];
 worker: { token: string };
}
export interface AgentTokenOptions {
 /** Seller names (case-insensitive) or IDs. Default: the three seeded demo sellers. */
 sellers?: string[];
 /** Token lifetime in hours (1-8760). Default 72. */
 hours?: number;
 baseUrl?: string;
}
export interface AgentTokenResult { principals: AgentPrincipals; revoked: number; expires_at: string; disabled: string[] }
interface SellerRow { id: string; name: string; owner_id: string; enabled: boolean }
const SEED_HINT='Run `npm run seed:negotiation --prefix backend` once to create the demo sellers.';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ensureActor(db: Db,id: string,label: string) {
 const t=db.database;
 const {data,error}=await t.from('commerce_actors').select('id').eq('id',id).limit(1);
 if(error) throw new Error(`Actor lookup: ${error.message}`);
 if(data?.length) return;
 const {error:insert}=await t.from('commerce_actors').insert([{id,label,is_demo:true}]);
 if(insert) throw new Error(`Actor insert: ${insert.message}`);
}

export async function mintAgentTokens(db: Db,{sellers:wanted,hours=72,baseUrl='http://127.0.0.1:8787'}: AgentTokenOptions={}): Promise<AgentTokenResult> {
 if(!Number.isInteger(hours)||hours<1||hours>8760) throw new Error('--hours must be an integer between 1 and 8760');
 const {data,error}=await db.database.from('commerce_sellers').select('id,name,owner_id,enabled');
 if(error) throw new Error(`Seller lookup: ${error.message}`);
 const all=(data??[]) as unknown as SellerRow[];
 let chosen: SellerRow[];
 if(!wanted?.length) {
  chosen=SELLERS.map(s=>{
   const row=all.find(r=>r.id===seedId(`seller:${s.slug}`));
   if(!row) throw new Error(`Demo seller ${s.name} not found. ${SEED_HINT}`);
   return row;
  });
 } else {
  chosen=wanted.map(w=>{
   const want=w.trim().toLowerCase();
   const hits=all.filter(r=>UUID.test(want)?r.id.toLowerCase()===want:r.name.toLowerCase()===want);
   if(!hits.length) throw new Error(`No seller named or with ID "${w}". ${SEED_HINT}`);
   if(hits.length>1) throw new Error(`Several sellers are named "${w}"; pass the seller UUID instead.`);
   return hits[0];
  });
  chosen=chosen.filter((s,i)=>chosen.findIndex(x=>x.id===s.id)===i);
 }
 const buyerAgentId=seedId('buyer-agent'),workerId=seedId('worker');
 await ensureActor(db,buyerAgentId,'Exchangent buyer agent');
 await ensureActor(db,workerId,'Exchangent agent worker');
 const token=()=>randomBytes(32).toString('hex');
 const buyer={actor_id:buyerAgentId,token:token(),scope:'buyer_agent' as const};
 const worker={token:token()};
 // Seller tokens act as the business's current owner, like the demo seed.
 const sellerTokens=chosen.map(s=>({seller_id:s.id,name:s.name,token:token(),owner_id:s.owner_id}));
 const rows=[
  {token_hash:hashToken(buyer.token),actor_id:buyerAgentId,scope:'buyer_agent',seller_id:null,label:'agents:buyer-agent'},
  {token_hash:hashToken(worker.token),actor_id:workerId,scope:'worker',seller_id:null,label:'agents:worker'},
  ...sellerTokens.map(s=>({token_hash:hashToken(s.token),actor_id:s.owner_id,scope:'seller',seller_id:s.seller_id,label:`agents:seller:${s.seller_id}`})),
 ];
 const rotated=await db.database.rpc('commerce_rotate_agent_principals',{p_principals:rows,p_hours:hours});
 if(rotated.error) throw new Error(`commerce_rotate_agent_principals failed: ${rotated.error.message}`+
  (/scope_check|buyer_agent|does not exist/.test(rotated.error.message)?' (apply migrations/20261018000400_buyer-agent.sql first)':''));
 const r=rotated.data as {revoked: number; expires_at: string};
 return {revoked:r.revoked,expires_at:r.expires_at,disabled:chosen.filter(s=>!s.enabled).map(s=>s.name),
  principals:{backend_url:baseUrl,buyer,sellers:sellerTokens.map(({seller_id,name,token})=>({seller_id,name,token})),worker}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 const args=parseArgs(process.argv.slice(2),{repeat:['seller']});
 const hours=args.hours===undefined?72:Number(args.hours);
 const db=await scriptDb();
 try {
  const result=await mintAgentTokens(db,{sellers:args.seller as string[] | undefined,hours,
   baseUrl:process.env.COMMERCE_BASE_URL||undefined});
  const file=process.env.AGENT_PRINCIPALS_FILE?pathToFileURL(process.env.AGENT_PRINCIPALS_FILE):new URL('../.agent-principals.json',import.meta.url);
  await writeFile(file,JSON.stringify(result.principals,null,2)+'\n',{mode:0o600});
  await chmod(file,0o600); // mode applies only on creation
  // Summary only: tokens stay in the file.
  console.log(JSON.stringify({wrote:file.pathname,backend_url:result.principals.backend_url,
   buyer_agent:result.principals.buyer.actor_id,sellers:result.principals.sellers.map(s=>`${s.name} ${s.seller_id}`),
   expires_at:result.expires_at,revoked_previous_agent_tokens:result.revoked},null,2));
  if(result.disabled.length) console.log(`Note: disabled sellers (no new sessions match them): ${result.disabled.join(', ')}`);
 } finally {await db.end?.();}
}
