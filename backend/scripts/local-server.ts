// Local full-stack rehearsal: the real backend app against a local Postgres (DATABASE_URL, every migration
// applied, e.g. the test:db container) with a fake Stripe Checkout. Opening the checkout URL "pays": it sends
// a locally signed checkout.session.completed to this server's own /webhooks/stripe, so the real payment,
// order and email code paths run. Primitive email is logged instead of sent unless PRIMITIVE_API_KEY and
// PRIMITIVE_FROM are set. Refunds succeed at once, and POST /__dispute/<order_id>[?reason=fraudulent] opens a
// signed charge.dispute.created for a paid order (src/disputes.ts answers it). Never for InsForge or real money.
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
 async create(p: {client_reference_id: string; metadata: Record<string,string>; line_items: {quantity: number; price_data: {unit_amount: number; currency: string}}[]}) {
  const id=`cs_test_${randomUUID().replaceAll('-','')}`;
  // Like Stripe: the total is the sum of every line (unit amount x quantity).
  const session={id,livemode:false,mode:'payment',client_reference_id:p.client_reference_id,metadata:p.metadata,
   amount_total:p.line_items.reduce((n,l)=>n+l.price_data.unit_amount*l.quantity,0),currency:p.line_items[0].price_data.currency,
   payment_intent:`pi_test_${randomUUID().replaceAll('-','')}`,
   payment_status:'unpaid',status:'open',url:`${base}/__checkout/${id}`};
  sessions.set(id,session);return session;
 },
 async retrieve(id: string) {return sessions.get(id);},
 async list(p: {payment_intent?: string}) {return {data:[...sessions.values()].filter(x=>x.payment_intent===p.payment_intent).slice(0,1)};},
}},
 // Refunds succeed at once; disputes record what the backend submitted (src/resolution.ts, src/disputes.ts).
 refunds:{async create(p: {payment_intent: string; amount: number},o: {idempotencyKey?: string}) {
  const id=`re_test_${(o.idempotencyKey??randomUUID()).replace(/[^a-z0-9]/gi,'').slice(-24)}`;
  console.log(`[refund] ${id} ${p.amount} cents on ${p.payment_intent}`);
  return {id,status:'succeeded',amount:p.amount,payment_intent:p.payment_intent};
 }},
 disputes:{
  async update(id: string,p: {evidence?: Record<string,unknown>; submit?: boolean}) {
   console.log(`[dispute] ${id} evidence submitted (${Object.keys(p.evidence??{}).join(', ')})`);
   return {id,status:'under_review'};
  },
  async close(id: string) {console.log(`[dispute] ${id} accepted (closed)`);return {id,status:'lost'};},
 },
};
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
const signed=(event: Record<string,unknown>)=>{
 const raw=JSON.stringify(event);
 return fetch(`${base}/webhooks/stripe`,{method:'POST',body:raw,headers:{'content-type':'application/json',
  'stripe-signature':signer.webhooks.generateTestHeaderString({payload:raw,secret})}});
};
app.on('request',async(req,res)=>{
 // POST /__dispute/<order_id>[?reason=fraudulent]: the buyer's bank opens a chargeback on that order.
 const dispute=req.method==='POST'?req.url?.match(/^\/__dispute\/([0-9a-f-]{36})(?:\?reason=([a-z_]+))?$/):null;
 if(dispute) {
  const {rows}=await db.pool.query<{stripe_session_id: string; total_cents: number}>(
   'SELECT stripe_session_id,total_cents FROM commerce_orders WHERE id=$1',[dispute[1]]);
  const session=rows[0]&&sessions.get(rows[0].stripe_session_id);
  if(!session) {res.writeHead(404).end('unknown order (pay it through this server first)');return;}
  const object={id:`dp_test_${randomUUID().replaceAll('-','')}`,object:'dispute',payment_intent:session.payment_intent,
   amount:rows[0].total_cents,currency:'usd',reason:dispute[2]??'product_not_received',status:'needs_response'};
  const hook=await signed({id:`evt_${randomUUID()}`,livemode:false,type:'charge.dispute.created',data:{object}});
  const text=await hook.text();
  console.log(`[dispute] ${object.id} opened; webhook ${hook.status} ${text}`);
  res.writeHead(hook.ok?200:502,{'content-type':'application/json'}).end(text);return;
 }
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
