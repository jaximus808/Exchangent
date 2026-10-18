import type { IncomingMessage, ServerResponse } from 'node:http';
import { CommerceError } from './commerce.ts';
import type { Commerce } from './commerce.ts';
import { errorBody, fail, id } from './negotiation.ts';
import type { Negotiation } from './negotiation.ts';
import { checkoutReturn } from './checkout-return.ts';
import { Resolution } from './resolution.ts';
import type { RolePrincipal, RoleScope } from './types.ts';

async function body(req: IncomingMessage) {
 const chunks: Buffer[]=[]; let bytes=0;
 for await(const c of req as AsyncIterable<Buffer>) {bytes+=c.length;if(bytes>262144) throw new CommerceError('body_too_large',413);chunks.push(c);}
 return Buffer.concat(chunks);
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
 const raw=(await body(req)).toString('utf8');
 if(!raw.trim()) return {};
 try {const input: unknown=JSON.parse(raw);if(!input||typeof input!=='object'||Array.isArray(input)) throw new Error();return input as Record<string, unknown>;} catch {throw fail('invalid_input','Body must be valid JSON');}
}
interface RouteContext {
 req: IncomingMessage; url: URL; m: RegExpMatchArray; p: RolePrincipal;
 key: string | string[] | undefined; n: Negotiation; commerce: Commerce; r: Resolution;
}
type Route=[method: string, pattern: RegExp, scope: RoleScope | null, handler: (c: RouteContext)=>unknown];
// [method, pattern, scopes, handler(ctx)]. Scopes are re-checked inside Negotiation methods.
const routes: Route[]=[
 ['GET',/^\/api\/v1\/me$/,null,c=>c.n.whoami(c.p)],
 ['POST',/^\/api\/v1\/buy-requests$/,null,async c=>c.n.createRequest(c.p,c.key,await json(c.req))],
 ['GET',/^\/api\/v1\/buy-requests\/([^/]+)$/,null,c=>c.n.getRequest(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/buy-requests\/([^/]+)\/offers$/,null,c=>c.n.listOffers(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/buy-requests\/([^/]+)\/conversation$/,null,c=>c.n.conversation(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/sessions\/([^/]+)$/,null,c=>c.n.getSession(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/sessions\/([^/]+)\/offers$/,null,async c=>c.n.makeOffer(c.p,c.m[1],c.key,await json(c.req))],
 ['POST',/^\/api\/v1\/sessions\/([^/]+)\/counters$/,null,async c=>c.n.counter(c.p,c.m[1],c.key,await json(c.req))],
 ['POST',/^\/api\/v1\/sessions\/([^/]+)\/decline$/,null,async c=>c.n.decline(c.p,c.m[1],c.key,await json(c.req))],
 ['GET',/^\/api\/v1\/seller\/sessions$/,null,c=>c.n.sellerSessions(c.p,c.url.searchParams.get('status'))],
 ['GET',/^\/api\/v1\/seller\/sessions\/([^/]+)\/conversation$/,null,c=>c.n.sellerConversation(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/seller\/inventory$/,null,c=>c.n.sellerInventory(c.p)],
 ['POST',/^\/api\/v1\/businesses$/,null,async c=>c.n.registerBusiness(c.p,await json(c.req))],
 ['GET',/^\/api\/v1\/seller\/business$/,null,c=>c.n.getBusiness(c.p)],
 ['PATCH',/^\/api\/v1\/seller\/business$/,null,async c=>c.n.updateBusiness(c.p,await json(c.req))],
 ['POST',/^\/api\/v1\/seller\/inventory$/,null,async c=>c.n.upsertInventory(c.p,await json(c.req))],
 ['GET',/^\/api\/v1\/worker\/events$/,null,c=>workerEvents(c)],
 ['POST',/^\/api\/v1\/worker\/sweep$/,null,c=>c.n.sweep(c.p)],
 ['POST',/^\/api\/v1\/worker\/events\/([^/]+)\/ack$/,null,async c=>ackEvent(c,await json(c.req))],
 ['POST',/^\/api\/v1\/worker\/sellers\/([^/]+)\/agent$/,null,async c=>c.n.setAgentHandle(c.p,c.m[1],await json(c.req))],
 ['POST',/^\/api\/v1\/worker\/sellers\/([^/]+)\/token$/,null,async c=>c.n.mintSellerAgentToken(c.p,c.m[1],await json(c.req))],
 // Orders, cases, refunds and disputes (src/resolution.ts, migration 0900). Scopes are checked inside Resolution.
 ['GET',/^\/api\/v1\/orders$/,null,c=>c.r.buyerOrders(c.p)],
 ['GET',/^\/api\/v1\/orders\/([^/]+)$/,null,c=>c.r.getOrder(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/orders\/([^/]+)\/received$/,null,c=>c.r.confirmReceived(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/orders\/([^/]+)\/cases$/,null,async c=>c.r.openCase(c.p,c.m[1],c.key,await json(c.req))],
 ['GET',/^\/api\/v1\/cases\/([^/]+)$/,null,c=>c.r.getCase(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/cases\/([^/]+)\/respond$/,null,async c=>c.r.respond(c.p,c.m[1],c.key,await json(c.req))],
 ['POST',/^\/api\/v1\/cases\/([^/]+)\/evidence$/,null,async c=>c.r.addEvidence(c.p,c.m[1],c.key,await json(c.req))],
 ['POST',/^\/api\/v1\/cases\/([^/]+)\/return-received$/,null,c=>c.r.returnReceived(c.p,c.m[1],c.key)],
 ['POST',/^\/api\/v1\/refunds\/([^/]+)\/retry$/,null,c=>c.r.retryRefund(c.p,c.m[1])],
 ['GET',/^\/api\/v1\/seller\/orders$/,null,c=>c.r.sellerOrders(c.p)],
 ['POST',/^\/api\/v1\/seller\/orders\/([^/]+)\/ship$/,null,async c=>c.r.ship(c.p,c.m[1],await json(c.req))],
 ['POST',/^\/api\/v1\/seller\/orders\/([^/]+)\/simulate-delivery$/,null,c=>c.r.simulateDelivery(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/seller\/orders\/([^/]+)\/issue$/,null,async c=>c.r.reportIssue(c.p,c.m[1],c.key,await json(c.req))],
 ['GET',/^\/api\/v1\/seller\/cases$/,null,c=>c.r.sellerCases(c.p)],
 ['GET',/^\/api\/v1\/seller\/policy$/,null,c=>c.r.getPolicy(c.p)],
 ['PUT',/^\/api\/v1\/seller\/policy$/,null,async c=>c.r.setPolicy(c.p,await json(c.req))],
 ['GET',/^\/api\/v1\/worker\/buyer-requests$/,null,c=>c.r.buyerRequestsByEmail(c.p,c.url.searchParams.get('email'))],
 ['GET',/^\/api\/v1\/worker\/sellers\/([^/]+)\/owner$/,null,c=>c.r.sellerOwner(c.p,c.m[1])],
 ['POST',/^\/api\/v1\/worker\/resolution-sweep$/,null,c=>c.r.sweep(c.p)],
 // Existing reservation and checkout routes: any buyer principal, unchanged behavior. Never the
 // buyer agent (buyer_agent scope): reserving and paying stay with the human buyer.
 ['POST',/^\/api\/v1\/offers\/([^/]+)\/reservations$/,'buyer',async c=>c.commerce.reserve(c.p.actor_id,id(c.m[1]),c.key,(await json(c.req)).expected_total_cents)],
 ['POST',/^\/api\/v1\/reservations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/checkout$/i,'buyer',c=>c.commerce.checkout(c.p.actor_id,id(c.m[1]))],
 ['GET',/^\/api\/v1\/reservations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,'buyer',c=>c.commerce.status(c.p.actor_id,id(c.m[1]))],
];
/**
 * The worker feed. A runner that sends ?include=resolution also gets resolution events (cases, refunds,
 * shipping, disputes), merged in creation order; older runners never see them.
 */
async function workerEvents(c: RouteContext) {
 const q=c.url.searchParams;
 const main=await c.n.workerEvents(c.p,q.get('limit'),q.get('v')) as {id: string; created_at: string}[];
 if(q.get('include')!=='resolution') return main;
 const n=q.get('limit')?Number(q.get('limit')):20;
 const res=await c.r.events(n);
 return [...main,...res].sort((a,b)=>a.created_at<b.created_at?-1:a.created_at>b.created_at?1:a.id<b.id?-1:1).slice(0,n);
}
/** Ack an event from either feed: the negotiation feed first, then resolution events. */
async function ackEvent(c: RouteContext,input: Record<string, unknown>) {
 try {return await c.n.ackEvent(c.p,c.m[1],input);}
 catch(error) {
  if(!(error instanceof CommerceError)||error.code!=='event_not_found') throw error;
  try {return await c.r.ack(id(c.m[1]),input.delivery);}
  catch(second) {
   if(second instanceof CommerceError&&second.code==='database_error') throw error; // before migration 0900
   throw second;
  }
 }
}
export function createHandler({commerce,negotiation,resolution=new Resolution({commerce,negotiation})}:
 {commerce: Commerce; negotiation: Negotiation; resolution?: Resolution}) {
 return async(req: IncomingMessage,res: ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const send=(code: number,data: unknown)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  try {
   const url=new URL(req.url as string,'http://127.0.0.1'),path=url.pathname;
   if(req.method==='GET'&&path==='/health') return send(200,{status:'ok',mode:'test'});
   if(req.method==='GET'&&['/success','/cancel'].includes(path))
     return checkoutReturn(res,path);
   if(req.method==='POST'&&path==='/webhooks/stripe')
     return send(200,{data:await commerce.webhook(await body(req),req.headers['stripe-signature'])});
   const p=await negotiation.principal(req.headers.authorization);
   for(const [method,pattern,scope,handler] of routes) {
    const m=path.match(pattern);
    if(!m||req.method!==method) continue;
    if(scope) negotiation.need(p,scope);
    return send(200,{data:await handler({req,url,m,p,key:req.headers['idempotency-key'],n:negotiation,commerce,r:resolution})});
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
