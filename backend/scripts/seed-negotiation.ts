// Demo seed for the negotiation loop: one buyer, three fictional San Francisco sellers,
// desks and chairs, and one bearer token per buyer, seller and worker. Re-runnable:
// fixtures use deterministic IDs (stock and prices are reset) and tokens are rotated.
// Writes backend/.demo-principals.json (gitignored). Only sha256(token) is stored.
//   InsForge: INSFORGE_URL + INSFORGE_API_KEY (backend/.env.local)
//   Local Postgres: DATABASE_URL (see test/sql/run.sh)
import { createHash, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hashToken } from '../src/negotiation.ts';
import type { Db, DbResult } from '../src/types.ts';

export function seedId(name: string) {
 const h=createHash('sha256').update(`exchangent-seed:${name}`).digest('hex');
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(8|parseInt(h[16],16)&3).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
export interface SeedItem {
 sku: string; title: string; category: 'desk' | 'chair'; attributes: Record<string, number | boolean>;
 list_cents: number; floor_cents: number; available: number;
}
export interface SeedSeller { slug: string; name: string; delivery_cents: number; delivery_days: number; items: SeedItem[] }
// $400 desk + ergonomic chair (desk <= 48in): every list-price bundle is over $400.
// Bay Desk Co reaches it only by negotiating toward its floors (floors + delivery = $345).
// Mission Ergonomics cannot (floors = $425). SoMa only stocks desks wider than 48in.
export const SELLERS: SeedSeller[]=[
 {slug:'bay-desk-co',name:'Bay Desk Co',delivery_cents:2500,delivery_days:1,items:[
  {sku:'BAY-DESK-46',title:'Bay 46in Walnut Desk',category:'desk',attributes:{width_in:46,adjustable:false},list_cents:26000,floor_cents:19000,available:3},
  {sku:'BAY-DESK-60',title:'Bay 60in Executive Desk',category:'desk',attributes:{width_in:60,adjustable:false},list_cents:42000,floor_cents:33000,available:2},
  {sku:'BAY-CHAIR-MESH',title:'Bay Mesh Ergonomic Chair',category:'chair',attributes:{ergonomic:true},list_cents:18000,floor_cents:13000,available:4},
 ]},
 {slug:'mission-ergonomics',name:'Mission Ergonomics',delivery_cents:0,delivery_days:2,items:[
  {sku:'MIS-DESK-48',title:'Mission 48in Sit-Stand Desk',category:'desk',attributes:{width_in:48,adjustable:true},list_cents:32000,floor_cents:26000,available:2},
  {sku:'MIS-CHAIR-PRO',title:'Mission Pro Ergonomic Chair',category:'chair',attributes:{ergonomic:true},list_cents:21000,floor_cents:16500,available:3},
  {sku:'MIS-CHAIR-TASK',title:'Mission Task Chair',category:'chair',attributes:{ergonomic:false},list_cents:9000,floor_cents:7000,available:5},
 ]},
 {slug:'soma-office-supply',name:'SoMa Office Supply',delivery_cents:1500,delivery_days:1,items:[
  {sku:'SOMA-DESK-60',title:'SoMa 60in Bench Desk',category:'desk',attributes:{width_in:60,adjustable:false},list_cents:24000,floor_cents:18000,available:4},
  {sku:'SOMA-DESK-72',title:'SoMa 72in Conference Desk',category:'desk',attributes:{width_in:72,adjustable:false},list_cents:39000,floor_cents:30000,available:1},
  {sku:'SOMA-CHAIR-ERGO',title:'SoMa Ergonomic Office Chair',category:'chair',attributes:{ergonomic:true},list_cents:15000,floor_cents:11000,available:6},
 ]},
];

/** Shape of backend/.demo-principals.json. */
export interface DemoPrincipals {
 backend_url: string;
 buyer: { actor_id: string; token: string };
 sellers: { seller_id: string; name: string; token: string }[];
 worker: { token: string };
}
export async function seed(db: Db,{buyerId=seedId('buyer'),baseUrl='http://127.0.0.1:8787'}: {buyerId?: string; baseUrl?: string}={}): Promise<DemoPrincipals> {
 const check=async(label: string,promise: PromiseLike<DbResult>)=>{const {error}=await promise;if(error) throw new Error(`Seed ${label}: ${error.message}`);};
 const t=db.database;
 const workerId=seedId('worker');
 // An existing buyer (a real account via DEMO_BUYER_ID) keeps its row: the seed only mints its agent token.
 const {data:existing,error}=await t.from('commerce_actors').select('id').eq('id',buyerId).limit(1);
 if(error) throw new Error(`Seed buyer lookup: ${error.message}`);
 await check('actors',t.from('commerce_actors').upsert([
  ...(existing?.length?[]:[{id:buyerId,label:'Demo buyer (negotiation seed)',is_demo:true}]),
  {id:workerId,label:'Exchangent agent worker',is_demo:true},
  ...SELLERS.map(s=>({id:seedId(`owner:${s.slug}`),label:`${s.name} owner`,is_demo:true})),
 ],{onConflict:'id'}));
 await check('sellers',t.from('commerce_sellers').upsert(SELLERS.map(s=>({id:seedId(`seller:${s.slug}`),
  owner_id:seedId(`owner:${s.slug}`),name:s.name,enabled:true,service_area:'san_francisco',
  delivery_cents:s.delivery_cents,delivery_days:s.delivery_days})),{onConflict:'id'}));
 await check('inventory',t.from('commerce_inventory').upsert(SELLERS.flatMap(s=>s.items.map(i=>({
  id:seedId(`inventory:${s.slug}:${i.sku}`),seller_id:seedId(`seller:${s.slug}`),...i}))),{onConflict:'id'}));
 // Rotate tokens: old seed tokens stop working.
 await check('principal cleanup',t.from('commerce_principals').delete().like('label','seed:%'));
 const token=()=>randomBytes(32).toString('hex');
 const buyer={actor_id:buyerId,token:token()};
 const sellers=SELLERS.map(s=>({seller_id:seedId(`seller:${s.slug}`),name:s.name,token:token(),actor_id:seedId(`owner:${s.slug}`),slug:s.slug}));
 const worker={token:token()};
 await check('principals',t.from('commerce_principals').insert([
  {token_hash:hashToken(buyer.token),actor_id:buyerId,scope:'buyer',label:'seed:buyer'},
  ...sellers.map(s=>({token_hash:hashToken(s.token),actor_id:s.actor_id,scope:'seller',seller_id:s.seller_id,label:`seed:seller:${s.slug}`})),
  {token_hash:hashToken(worker.token),actor_id:workerId,scope:'worker',label:'seed:worker'},
 ]));
 return {backend_url:baseUrl,buyer,sellers:sellers.map(({seller_id,name,token})=>({seller_id,name,token})),worker};
}

if(import.meta.url===pathToFileURL(process.argv[1]).href) {
 let db: Db & {end?: ()=>Promise<void>};
 if(process.env.DATABASE_URL) db=(await import('./pg-db.ts')).pgDb(process.env.DATABASE_URL);
 else {
  if(!process.env.INSFORGE_URL||!process.env.INSFORGE_API_KEY) throw new Error('Set INSFORGE_URL and INSFORGE_API_KEY (backend/.env.local) or DATABASE_URL');
  const {createAdminClient}=await import('@insforge/sdk');
  const {asDb}=await import('../src/commerce.ts');
  db=asDb(createAdminClient({baseUrl:process.env.INSFORGE_URL,apiKey:process.env.INSFORGE_API_KEY}));
 }
 // DEMO_BUYER_ID: mint the buyer agent's token for this actor, e.g. your own account's actor, so the agent
 // runner's buyer agent negotiates the orders you create in chat.
 const principals=await seed(db,{buyerId:process.env.DEMO_BUYER_ID||undefined,baseUrl:process.env.COMMERCE_BASE_URL||undefined});
 const file=process.env.DEMO_PRINCIPALS_FILE?pathToFileURL(process.env.DEMO_PRINCIPALS_FILE):new URL('../.demo-principals.json',import.meta.url);
 await writeFile(file,JSON.stringify(principals,null,2)+'\n',{mode:0o600});
 await db.end?.();
 console.log(JSON.stringify({wrote:file.pathname,buyer:principals.buyer.actor_id,
  sellers:principals.sellers.map(s=>`${s.name} ${s.seller_id}`)},null,2));
}
