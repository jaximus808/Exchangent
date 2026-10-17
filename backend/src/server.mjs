import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CommerceError, fromEnv } from './commerce.mjs';
const commerce=fromEnv();
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function authenticated(req) {
 const expected=Buffer.from(`Bearer ${process.env.COMMERCE_DEMO_TOKEN}`);
 const actual=Buffer.from(req.headers.authorization??'');
 return expected.length===actual.length && timingSafeEqual(expected,actual);
}
async function body(req) {
 const chunks=[]; let bytes=0;
 for await(const c of req) {bytes+=c.length;if(bytes>262144) throw new CommerceError('body_too_large',413);chunks.push(c);}
 return Buffer.concat(chunks);
}
export const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 try {
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(req.method==='GET'&&path==='/health') return send(200,{status:'ok',mode:'test'});
  if(req.method==='GET'&&['/success','/cancel'].includes(path))
    return send(200,{message:'Payment status is confirmed only by the verified Stripe webhook. Return to the assistant to check your order.'});
  if(req.method==='POST'&&path==='/webhooks/stripe')
    return send(200,{data:await commerce.webhook(await body(req),req.headers['stripe-signature'])});
  if(!authenticated(req)) throw new CommerceError('unauthorized',401);
  const buyer=process.env.DEMO_BUYER_ID;
  let match=path.match(/^\/api\/v1\/offers\/([^/]+)\/reservations$/);
  if(match&&req.method==='POST') {
    if(!uuid.test(match[1])) throw new CommerceError('invalid_id',400);
    return send(200,{data:await commerce.reserve(buyer,match[1],req.headers['idempotency-key'])});
  }
  match=path.match(/^\/api\/v1\/reservations\/([^/]+)(\/checkout)?$/);
  if(match&&uuid.test(match[1])) {
    if(req.method==='POST'&&match[2]) return send(200,{data:await commerce.checkout(buyer,match[1])});
    if(req.method==='GET'&&!match[2]) return send(200,{data:await commerce.status(buyer,match[1])});
  }
  throw new CommerceError('not_found',404);
 } catch(error) {
  // Do not expose SQL/SDK/Stripe internals or credentials in an HTTP response.
  const safe=error instanceof CommerceError;
  send(safe?error.status:500,{error:{code:safe&&/^[a-z_]+$/.test(error.code)?error.code:'operation_failed',
    message:'The operation could not be completed. Check the current reservation or retry.',next_action:'check_status'}});
 }
});
// This milestone deliberately exposes no public API using the demo token.
server.listen(Number(process.env.PORT??8787),'127.0.0.1',()=>console.log('Exchangent test backend: http://127.0.0.1:8787'));
