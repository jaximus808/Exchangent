import { CommerceError } from './commerce.mjs';
import { errorBody, fail, id } from './negotiation.mjs';

async function body(req) {
 const chunks=[]; let bytes=0;
 for await(const c of req) {bytes+=c.length;if(bytes>262144) throw new CommerceError('body_too_large',413);chunks.push(c);}
 return Buffer.concat(chunks);
}
async function json(req) {
 const raw=(await body(req)).toString('utf8');
 if(!raw.trim()) return {};
 try {return JSON.parse(raw);} catch {throw fail('invalid_input','Body must be valid JSON');}
}
// [method, pattern, scopes, handler(ctx)]. Scopes are re-checked inside Negotiation methods.
const routes=[
 ['GET',/^\/api\/v1\/me$/,null,c=>c.n.whoami(c.p)],
 ['POST',/^\/api\/v1\/buy-requests$/,null,async c=>c.n.createRequest(c.p,c.key,await json(c.req))],
 ['GET',/^\/api\/v1\/buy-requests\/([^/]+)$/,null,c=>c.n.getRequest(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/buy-requests\/([^/]+)\/offers$/,null,c=>c.n.listOffers(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/sessions\/([^/]+)$/,null,c=>c.n.getSession(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/sessions\/([^/]+)\/offers$/,null,async c=>c.n.makeOffer(c.p,c.m[1],c.key,await json(c.req))],
 ['POST',/^\/api\/v1\/sessions\/([^/]+)\/counters$/,null,async c=>c.n.counter(c.p,c.m[1],c.key,await json(c.req))],
 ['POST',/^\/api\/v1\/sessions\/([^/]+)\/decline$/,null,async c=>c.n.decline(c.p,c.m[1],c.key,await json(c.req))],
 ['GET',/^\/api\/v1\/seller\/sessions$/,null,c=>c.n.sellerSessions(c.p,c.url.searchParams.get('status'))],
 ['GET',/^\/api\/v1\/seller\/inventory$/,null,c=>c.n.sellerInventory(c.p)],
 ['GET',/^\/api\/v1\/worker\/events$/,null,c=>c.n.workerEvents(c.p,c.url.searchParams.get('limit'))],
 ['POST',/^\/api\/v1\/worker\/events\/([^/]+)\/ack$/,null,c=>c.n.ackEvent(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/worker\/sellers\/([^/]+)\/agent$/,null,async c=>c.n.setAgentHandle(c.p,c.m[1],await json(c.req))],
 // Existing reservation and checkout routes: any buyer principal, unchanged behavior.
 ['POST',/^\/api\/v1\/offers\/([^/]+)\/reservations$/,'buyer',c=>c.commerce.reserve(c.p.actor_id,id(c.m[1]),c.key)],
 ['POST',/^\/api\/v1\/reservations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/checkout$/i,'buyer',c=>c.commerce.checkout(c.p.actor_id,id(c.m[1]))],
 ['GET',/^\/api\/v1\/reservations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,'buyer',c=>c.commerce.status(c.p.actor_id,id(c.m[1]))],
];
export function createHandler({commerce,negotiation}) {
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  try {
   const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
   if(req.method==='GET'&&path==='/health') return send(200,{status:'ok',mode:'test'});
   if(req.method==='GET'&&['/success','/cancel'].includes(path))
     return send(200,{message:'Payment status is confirmed only by the verified Stripe webhook. Return to the assistant to check your order.'});
   if(req.method==='POST'&&path==='/webhooks/stripe')
     return send(200,{data:await commerce.webhook(await body(req),req.headers['stripe-signature'])});
   const p=await negotiation.principal(req.headers.authorization);
   for(const [method,pattern,scope,handler] of routes) {
    const m=path.match(pattern);
    if(!m||req.method!==method) continue;
    if(scope) negotiation.need(p,scope);
    return send(200,{data:await handler({req,url,m,p,key:req.headers['idempotency-key'],n:negotiation,commerce})});
   }
   throw new CommerceError('not_found',404);
  } catch(error) {
   // Do not expose SQL/SDK/Stripe internals or credentials in an HTTP response.
   if(!(error instanceof CommerceError)) console.error(error);
   const {status,body:payload}=errorBody(error);
   send(status,payload);
  }
 };
}
