/** Explicit integration check against the running backend and linked test project.
 * Uses private demo credentials, creates one request and two offers, then declines
 * its sessions. No checkout, payment or inventory reservation is created.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.EXCHANGENT_API_URL ||= 'http://127.0.0.1:8787/api/v1';
delete process.env.EXCHANGENT_TOKEN;
const credentials=JSON.parse(await readFile(new URL('../../backend/.demo-principals.json',import.meta.url),'utf8'));
const {default:server}=await import('../index.ts');
const {url}=await server.listen(0);
const clients:Client[]=[];
async function connect(token:string) {
 const client=new Client({name:'exchangent-live-check',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 clients.push(client);return client;
}
async function call(client:Client,name:string,args:Record<string,unknown>) {
 const result=await client.callTool({name,arguments:args});
 const data=result.structuredContent as Record<string,any>;
 assert.equal(data?.status,'ok',JSON.stringify(data??result));return data;
}
let buyer:Client|undefined;
let sessions:any[]=[];
try {
 buyer=await connect(credentials.buyer.token);
 const seller=await connect(credentials.sellers[0].token);
 const request=await call(buyer,'create_buy_order',{title:'Integration check: desk and chair',
  requirements:{region:'san_francisco',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]},
  budget_cents:40000,target_cents:36000,idempotency_key:randomUUID()});
 sessions=request.sessions;
 assert.equal(sessions.length,2);
 const session=sessions.find(s=>s.seller_id===credentials.sellers[0].seller_id);
 const inventory=await call(seller,'get_inventory',{});
 const stock=inventory.items??inventory.inventory??inventory.data;
 assert.ok(Array.isArray(stock),'Inventory result must include an array');
 const desk=stock.find((i:any)=>i.sku==='BAY-DESK-46');
 const chair=stock.find((i:any)=>i.sku==='BAY-CHAIR-MESH');
 const lines=(d:number,c:number)=>[{inventory_id:desk.inventory_id,quantity:1,unit_cents:d},{inventory_id:chair.inventory_id,quantity:1,unit_cents:c}];
 await call(seller,'make_offer',{session_id:session.session_id,expected_version:0,items:lines(26000,18000),delivery_cents:2500});
 await call(buyer,'counter_offer',{session_id:session.session_id,expected_version:1,total_cents:36000});
 await call(seller,'make_offer',{session_id:session.session_id,expected_version:2,items:lines(20500,13000),delivery_cents:2500});
 const offers=await call(buyer,'list_offers',{request_id:request.request_id});
 assert.equal(offers.offers[0].total_cents,36000);
 assert.ok(!JSON.stringify(offers).includes('floor_cents'));
 console.log('LIVE MCP PASS: matched sellers -> $465 offer -> $360 counter -> $360 seller offer; no floors exposed.');
} finally {
 if(buyer) for(const s of sessions) await call(buyer,'decline_seller',{session_id:s.session_id,reason:'Integration check complete; no purchase.'}).catch(()=>{});
 for(const client of clients) await client.close().catch(()=>{});
 await server.close();
}
