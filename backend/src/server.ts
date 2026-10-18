import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CommerceError, fromEnv } from './commerce.ts';
import type { Commerce } from './commerce.ts';
import { authFromEnv, requireUser } from './auth.ts';
import type { Auth } from './auth.ts';
import { Activity } from './activity.ts';
import { Negotiation } from './negotiation.ts';
import { createHandler } from './http.ts';
import { Resolution, userResolutionRoute } from './resolution.ts';
import { checkoutReturn } from './checkout-return.ts';
import { OAuth, tokenEndpoint } from './oauth.ts';

async function body(req: IncomingMessage) {
  const chunks: Buffer[]=[];let bytes=0;
  for await(const chunk of req as AsyncIterable<Buffer>) {
    bytes+=chunk.length;
    if(bytes>262144) throw new CommerceError('body_too_large',413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req: IncomingMessage,allowEmpty=false): Promise<Record<string, unknown>> {
  try {
    const raw=await body(req);
    const input: unknown=allowEmpty&&!raw.length?{}:JSON.parse(raw.toString());
    if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error();
    return input as Record<string, unknown>;
  } catch(error) {
    if(error instanceof CommerceError) throw error;
    throw new CommerceError('invalid_json',400);
  }
}
export interface AppOptions { commerce: Commerce; auth: Auth; activity?: Activity; negotiation?: Negotiation; oauth?: OAuth }
// Seeded 64-hex demo role tokens and `exc_` connector access tokens use the negotiation routes.
const ROLE_TOKEN=/^Bearer (?:[a-f0-9]{64}|exc_[A-Za-z0-9_-]{16,512})$/;
export function createApp({commerce,auth,activity=new Activity(commerce),negotiation=new Negotiation({db:commerce.db}),
  oauth=new OAuth({db:commerce.db})}: AppOptions) {
  const resolution=new Resolution({commerce,negotiation});
  const negotiationHandler=createHandler({commerce,negotiation,resolution});
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(code: number,data: unknown)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      const url=new URL(req.url as string,'http://127.0.0.1'),path=url.pathname;
      if(req.method==='GET'&&path==='/health') return send(200,{status:'ok',mode:'test'});
      if(req.method==='GET'&&['/success','/cancel'].includes(path))
        return checkoutReturn(res,path);
      if(req.method==='POST'&&path==='/webhooks/stripe')
        return send(200,{data:await commerce.webhook(await body(req),req.headers['stripe-signature'])});
      // OAuth token endpoint: client-authenticated, no Bearer token, RFC 6749 JSON.
      if(path==='/api/v1/oauth/token') return tokenEndpoint(oauth,req,res);
      const roleToken=ROLE_TOKEN.test(req.headers.authorization??'');
      // Consent APIs: a verified InsForge user session only (doc/oauth-contract.md).
      if(path==='/api/v1/oauth/targets'||path==='/api/v1/oauth/authorize') {
        if(roleToken) throw new CommerceError('user_session_required',403);
        const principal=await auth.authenticate(req.headers.authorization);
        if(req.method==='GET'&&path==='/api/v1/oauth/targets') return send(200,{data:await oauth.targets(principal,url.searchParams)});
        if(req.method==='POST'&&path==='/api/v1/oauth/authorize') return send(200,{data:await oauth.authorize(principal,await json(req))});
        throw new CommerceError('not_found',404);
      }
      // Seeded role tokens use a separate, expiring demo identity; connector tokens resolve to
      // the same buyer/seller principals. User sessions and task delegations always pass
      // through the scoped authentication path below.
      if(roleToken) return negotiationHandler(req,res);
      const principal=await auth.authenticate(req.headers.authorization);
      if(req.method==='GET'&&path==='/api/v1/me') return send(200,{data:{
        actor_id:principal.actorId,kind:principal.kind,scopes:principal.scopes??null,
        request_id:principal.requestId??null,seller_id:principal.sellerId??null,
      }});
      // Consent page "Create a business": the signed-in person becomes its owner.
      if(req.method==='POST'&&path==='/api/v1/businesses') {
        requireUser(principal);
        return send(201,{data:await negotiation.registerBusinessFor(principal.actorId,await json(req))});
      }
      if(req.method==='GET'&&path==='/api/v1/businesses') return send(200,{data:await activity.businesses(principal)});
      // Orders, cases and the resolution policy for the web dashboard (src/resolution.ts).
      const resolved=await userResolutionRoute(resolution,{actor:()=>(requireUser(principal),principal.actorId),method:req.method,path,
        key:req.headers['idempotency-key'],input:()=>json(req,true),ownBusiness:id=>activity.ownBusiness(principal,id)});
      if(resolved!==undefined) return send(200,{data:resolved});
      const business=path.match(/^\/api\/v1\/businesses\/([^/]+)(?:\/(sessions|inventory))?$/);
      if(business) {
        if(req.method==='GET'&&business[2]==='sessions') return send(200,{data:await activity.businessSessions(principal,business[1])});
        if(req.method==='POST'&&business[2]==='inventory') return send(200,{data:await activity.upsertInventory(principal,business[1],await json(req))});
        if(req.method==='PATCH'&&!business[2]) return send(200,{data:await activity.updateBusiness(principal,business[1],await json(req))});
      }
      if(req.method==='POST'&&path==='/api/v1/buy-requests')
        return send(200,{data:await activity.createRequest(principal,await json(req),req.headers['idempotency-key'])});
      if(req.method==='GET'&&path==='/api/v1/buy-requests')
        return send(200,{data:await activity.requests(principal)});
      if(req.method==='POST'&&path==='/api/v1/delegations')
        return send(201,{data:await auth.createDelegation(principal,await json(req))});
      let match=path.match(/^\/api\/v1\/delegations\/([^/]+)$/);
      if(match&&req.method==='DELETE') return send(200,{data:await auth.revoke(principal,match[1])});
      match=path.match(/^\/api\/v1\/buy-requests\/([^/]+)(\/offers|\/conversation)?$/);
      if(match&&req.method==='GET') return send(200,{data:await activity[match[2]==='/offers'?'offers':match[2]?'conversation':'request'](principal,match[1])});
      match=path.match(/^\/api\/v1\/sellers\/([^/]+)\/activity$/);
      if(match&&req.method==='GET') return send(200,{data:await activity.seller(principal,match[1])});
      match=path.match(/^\/api\/v1\/offers\/([^/]+)\/reservations$/);
      if(match&&req.method==='POST') return send(200,{data:await activity.reserve(principal,match[1],req.headers['idempotency-key'],await json(req,true))});
      match=path.match(/^\/api\/v1\/reservations\/([^/]+)(\/checkout)?$/);
      if(match) {
        if(req.method==='POST'&&match[2]) return send(200,{data:await activity.checkout(principal,match[1])});
        if(req.method==='GET'&&!match[2]) return send(200,{data:await activity.status(principal,match[1])});
      }
      throw new CommerceError('not_found',404);
    } catch(error) {
      const safe=error instanceof CommerceError;
      send(safe?error.status:500,{error:{code:safe&&/^[a-z_]+$/.test(error.code)?error.code:'operation_failed',
        message:'The operation could not be completed. Check access and current status before retrying.',
        next_action:safe&&error.status===401?'sign_in':'check_status'}});
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const commerce=fromEnv();
  const server=createApp({commerce,auth:authFromEnv(commerce)});
  const port=Number(process.env.PORT??8787);
  server.listen(port,'127.0.0.1',()=>console.log(`Exchangent authenticated test API: http://127.0.0.1:${port}`));
}
