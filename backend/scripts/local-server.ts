// Local full-stack rehearsal: the real backend app against a local Postgres (DATABASE_URL, every migration
// applied, e.g. the test:db container) with a fake Stripe Checkout. Opening the checkout URL "pays": it sends
// a locally signed checkout.session.completed to this server's own /webhooks/stripe, so the real payment,
// order and email code paths run. Primitive email is logged instead of sent unless PRIMITIVE_API_KEY and
// PRIMITIVE_FROM are set. Never for InsForge or real money.
//   DATABASE_URL=postgres://... node scripts/local-server.ts        (PORT, default 8787)
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { pgDb } from './pg-db.ts';
import { Commerce, CommerceError } from '../src/commerce.ts';
import { OrderEmail, orderEmailFromEnv } from '../src/order-email.ts';
import { createApp } from '../src/server.ts';
import type { AppOptions } from '../src/server.ts';

if(!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a local Postgres with every migration applied');
const port=Number(process.env.PORT??8787),base=`http://127.0.0.1:${port}`;
const db=pgDb(process.env.DATABASE_URL);
const secret=`whsec_local_${randomUUID()}`,signer=new Stripe('sk_test_local_rehearsal');
const sessions=new Map<string,Record<string,unknown>>();
const stripe={webhooks:signer.webhooks,checkout:{sessions:{
 async create(p: {client_reference_id: string; metadata: Record<string,string>; line_items: {price_data: {unit_amount: number; currency: string}}[]}) {
  const id=`cs_test_${randomUUID().replaceAll('-','')}`;
  const session={id,livemode:false,mode:'payment',client_reference_id:p.client_reference_id,metadata:p.metadata,
   amount_total:p.line_items[0].price_data.unit_amount,currency:p.line_items[0].price_data.currency,
   payment_status:'unpaid',status:'open',url:`${base}/__checkout/${id}`};
  sessions.set(id,session);return session;
 },
 async retrieve(id: string) {return sessions.get(id);},
}}};
// Without Primitive settings, log what would be sent (recipient domain only).
const orderEmail=orderEmailFromEnv(db)??new OrderEmail({db,apiKey:'local',from:'orders@exchangent.local',
 fetch:(async(_url: string,init: RequestInit)=>{
  const body=JSON.parse(init.body as string) as {to: string; subject: string};
  console.log(`[email] would send "${body.subject}" to *@${String(body.to).split('@')[1]}`);
  return Response.json({success:true,data:{id:randomUUID(),status:'queued'}});
 }) as typeof globalThis.fetch});
const commerce=new Commerce({db,stripe:stripe as unknown as Stripe,webhookSecret:secret,baseUrl:base,integrationId:'local',orderEmail});
// Role and connector tokens use the negotiation routes; InsForge user sessions are not available locally.
const app=createApp({commerce,auth:{authenticate:async()=>{throw new CommerceError('unauthorized',401);}} as unknown as AppOptions['auth']});
const handle=app.listeners('request')[0] as (req: import('node:http').IncomingMessage,res: import('node:http').ServerResponse)=>void;
app.removeAllListeners('request');
app.on('request',async(req,res)=>{
 const m=req.url?.match(/^\/__checkout\/(cs_test_[a-f0-9]+)$/);
 if(!m) return handle(req,res);
 const session=sessions.get(m[1]);
 if(!session) {res.writeHead(404).end('unknown checkout session');return;}
 Object.assign(session,{payment_status:'paid',status:'complete'});
 const raw=JSON.stringify({id:`evt_${randomUUID()}`,livemode:false,type:'checkout.session.completed',data:{object:{id:session.id}}});
 const hook=await fetch(`${base}/webhooks/stripe`,{method:'POST',body:raw,headers:{'content-type':'application/json',
  'stripe-signature':signer.webhooks.generateTestHeaderString({payload:raw,secret})}});
 console.log(`[checkout] ${session.id} paid; webhook ${hook.status} ${await hook.text()}`);
 res.writeHead(hook.ok?200:502,{'content-type':'text/plain'}).end(hook.ok?'Paid (local fake checkout).':'Webhook failed.');
});
app.listen(port,'127.0.0.1',()=>console.log(`Exchangent local rehearsal API: ${base} (fake Stripe Checkout)`));
