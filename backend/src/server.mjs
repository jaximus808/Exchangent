import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CommerceError, fromEnv } from './commerce.mjs';
import { authFromEnv } from './auth.mjs';
import { Activity } from './activity.mjs';

async function body(req) {
  const chunks=[];let bytes=0;
  for await(const chunk of req) {
    bytes+=chunk.length;
    if(bytes>262144) throw new CommerceError('body_too_large',413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function json(req) {
  try {
    const input=JSON.parse((await body(req)).toString());
    if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error();
    return input;
  } catch(error) {
    if(error instanceof CommerceError) throw error;
    throw new CommerceError('invalid_json',400);
  }
}
export function createApp({commerce,auth,activity=new Activity(commerce)}) {
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      const path=new URL(req.url,'http://127.0.0.1').pathname;
      if(req.method==='GET'&&path==='/health') return send(200,{status:'ok',mode:'test'});
      if(req.method==='GET'&&['/success','/cancel'].includes(path))
        return send(200,{message:'Payment status is confirmed only by the verified Stripe webhook. Return to the assistant to check your order.'});
      if(req.method==='POST'&&path==='/webhooks/stripe')
        return send(200,{data:await commerce.webhook(await body(req),req.headers['stripe-signature'])});
      const principal=await auth.authenticate(req.headers.authorization);
      if(req.method==='GET'&&path==='/api/v1/me') return send(200,{data:{
        actor_id:principal.actorId,kind:principal.kind,scopes:principal.scopes??null,
        request_id:principal.requestId??null,seller_id:principal.sellerId??null,
      }});
      if(req.method==='POST'&&path==='/api/v1/buy-requests')
        return send(200,{data:await activity.createRequest(principal,await json(req),req.headers['idempotency-key'])});
      if(req.method==='GET'&&path==='/api/v1/buy-requests')
        return send(200,{data:await activity.requests(principal)});
      if(req.method==='POST'&&path==='/api/v1/delegations')
        return send(201,{data:await auth.createDelegation(principal,await json(req))});
      let match=path.match(/^\/api\/v1\/delegations\/([^/]+)$/);
      if(match&&req.method==='DELETE') return send(200,{data:await auth.revoke(principal,match[1])});
      match=path.match(/^\/api\/v1\/buy-requests\/([^/]+)(\/offers)?$/);
      if(match&&req.method==='GET') return send(200,{data:await activity[match[2]?'offers':'request'](principal,match[1])});
      match=path.match(/^\/api\/v1\/sellers\/([^/]+)\/activity$/);
      if(match&&req.method==='GET') return send(200,{data:await activity.seller(principal,match[1])});
      match=path.match(/^\/api\/v1\/offers\/([^/]+)\/reservations$/);
      if(match&&req.method==='POST') return send(200,{data:await activity.reserve(principal,match[1],req.headers['idempotency-key'])});
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
