// Real-database checks for the order confirmation email (migrations/20261018000300_order-email.sql).
// Run with `npm run test:db`. Drives POST /webhooks/stripe on the production HTTP app with a locally
// signed Stripe event: commerce_apply_payment, the order.confirmed outbox row, the auth.users email
// lookup and the ack are all real. Stripe's session read and Primitive are fakes (no network).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import Stripe from 'stripe';
import { pgDb } from '../../scripts/pg-db.ts';
import { CommerceError, Commerce } from '../../src/commerce.ts';
import { OrderEmail } from '../../src/order-email.ts';
import { createApp } from '../../src/server.ts';
import type { AppOptions } from '../../src/server.ts';
import type { ReservationRow, Row } from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const db=pgDb(process.env.DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
const secret='whsec_order_email_db',signer=new Stripe('sk_test_fixture');
const sessions=new Map<string,Record<string,unknown>>();
interface Sent { headers: Record<string,string>; body: Record<string,unknown> }
const sent: Sent[]=[],logs: string[]=[];
let fail=0;
let server: ReturnType<typeof createApp>,base: string;
before(async()=>{
 const fetch=(async(_url: string,init: RequestInit)=>{
  sent.push({headers:init.headers as Record<string,string>,body:JSON.parse(init.body as string)});
  if(fail>0) {fail--;return Response.json({success:false,error:{code:'recipient_not_allowed'}},{status:403});}
  return Response.json({success:true,data:{id:randomUUID(),status:'queued'}});
 }) as typeof globalThis.fetch;
 const stripe={webhooks:signer.webhooks,checkout:{sessions:{retrieve:async(id: string)=>sessions.get(id)}}};
 const commerce=new Commerce({db,stripe:stripe as unknown as Stripe,webhookSecret:secret,baseUrl:'http://127.0.0.1',
  integrationId:'test',orderEmail:new OrderEmail({db,apiKey:'prim_db_test_only',from:'orders@exchangent.primitive.email',fetch,log:l=>logs.push(l)})});
 server=createApp({commerce,auth:{authenticate:async()=>{throw new CommerceError('unauthorized',401);}} as unknown as AppOptions['auth']});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{server?.close();await db.end();});

/** A held, checkout-bound reservation for a fresh buyer: email null makes a demo actor without an account. */
async function bound(email: string | null) {
 const user=email?randomUUID():null;
 if(user) await sql('INSERT INTO auth.users(id,email) VALUES($1,$2)',[user,email]);
 const [{id:buyer}]=await sql<{id: string}>('INSERT INTO commerce_actors(auth_user_id,label) VALUES($1,$2) RETURNING id',[user,'order-email buyer']);
 const [{id:owner}]=await sql<{id: string}>(`INSERT INTO commerce_actors(label,is_demo) VALUES('order-email owner',true) RETURNING id`);
 const [{id:seller}]=await sql<{id: string}>(`INSERT INTO commerce_sellers(owner_id,name) VALUES($1,'Order Email Desk Co') RETURNING id`,[owner]);
 const [{id:inventory}]=await sql<{id: string}>(`INSERT INTO commerce_inventory(seller_id,sku,title,floor_cents,available)
  VALUES($1,'desk','Oak desk',10000,5) RETURNING id`,[seller]);
 const [{id:request}]=await sql<{id: string}>('INSERT INTO commerce_requests(buyer_id,budget_cents) VALUES($1,50000) RETURNING id',[buyer]);
 const [{id:offer}]=await sql<{id: string}>(`INSERT INTO commerce_offers(request_id,seller_id,version,delivery_cents,tax_cents,expires_at)
  VALUES($1,$2,1,2500,1000,now()+interval '1 hour') RETURNING id`,[request,seller]);
 await sql('INSERT INTO commerce_offer_items VALUES($1,$2,2,15000)',[offer,inventory]);
 const rpc=async<T,>(name: string,args: Record<string,unknown>)=>{const {data,error}=await db.database.rpc(name,args);assert.equal(error,null);return data as T;};
 const r=await rpc<ReservationRow>('commerce_reserve',{p_buyer:buyer,p_offer:offer,p_key:randomUUID()});
 await rpc('commerce_begin_checkout',{p_buyer:buyer,p_reservation:r.id});
 const sessionId=`cs_test_${randomUUID().replaceAll('-','')}`;
 await rpc('commerce_bind_checkout',{p_reservation:r.id,p_session:sessionId,p_url:'https://checkout.stripe.test'});
 sessions.set(sessionId,{id:sessionId,livemode:false,mode:'payment',client_reference_id:r.id,metadata:{reservation_id:r.id},
  amount_total:r.total_cents,currency:'usd',payment_status:'paid',status:'complete'});
 return {reservation:r.id,sessionId};
}
async function webhook(sessionId: string,eventId: string,type='checkout.session.completed') {
 const raw=JSON.stringify({id:eventId,livemode:false,type,data:{object:{id:sessionId}}});
 const res=await fetch(`${base}/webhooks/stripe`,{method:'POST',body:raw,
  headers:{'content-type':'application/json','stripe-signature':signer.webhooks.generateTestHeaderString({payload:raw,secret})}});
 return {status:res.status,body:await res.json() as {data?: {duplicate: boolean; order_id?: string; confirmed?: boolean}}};
}
const outbox=async(order: string)=>(await sql<{delivered_at: Date | null}>(
 `SELECT delivered_at FROM commerce_outbox WHERE kind='order.confirmed' AND aggregate_id=$1`,[order]))[0];

test('paid webhook emails the buyer once with the reserved receipt, and retries never resend',async()=>{
 sent.length=0;
 const {sessionId}=await bound('Buyer.OrderEmail@example.test');
 const eventId=`evt_${randomUUID()}`;
 const first=await webhook(sessionId,eventId);
 assert.equal(first.status,200);assert.equal(first.body.data?.confirmed,true);
 const order=first.body.data!.order_id!;
 assert.equal(sent.length,1);
 const [{headers,body}]=sent;
 assert.equal(body.to,'Buyer.OrderEmail@example.test');
 assert.equal(headers['idempotency-key'],`exchangent-order-confirmed-${order}`);
 assert.equal(body.subject,'Order confirmed: Order Email Desk Co, $335.00');
 for(const part of ['2 × Oak desk: $300.00','Delivery: $25.00','Tax: $10.00','Total paid: $335.00',`Order: ${order}`])
  assert.ok((body.body_text as string).includes(part),part);
 assert.ok((await outbox(order)).delivered_at);
 // Stripe retries the same event, then sends a second event for the same session.
 const retried=await webhook(sessionId,eventId);
 assert.equal(retried.status,200);assert.deepEqual(retried.body.data,{duplicate:true});
 const second=await webhook(sessionId,`evt_${randomUUID()}`,'checkout.session.async_payment_succeeded');
 assert.equal(second.status,200);assert.equal(second.body.data?.order_id,order);
 assert.equal(sent.length,1);
 assert.equal((await sql('SELECT 1 FROM commerce_orders WHERE id=$1',[order])).length,1);
});

test('same Stripe event retried after a failed send: webhook still 200, then exactly one delivery',async()=>{
 sent.length=0;logs.length=0;fail=1;
 const {sessionId}=await bound('retry.buyer@example.test');
 const eventId=`evt_${randomUUID()}`;
 const first=await webhook(sessionId,eventId);
 assert.equal(first.status,200);assert.equal(first.body.data?.confirmed,true);
 const order=first.body.data!.order_id!;
 assert.equal((await outbox(order)).delivered_at,null);
 assert.deepEqual(logs,[`order_email failed order=${order} reason=primitive_403_recipient_not_allowed`]);
 const again=await webhook(sessionId,eventId);
 assert.equal(again.status,200);assert.deepEqual(again.body.data,{duplicate:true});
 assert.ok((await outbox(order)).delivered_at);
 await webhook(sessionId,eventId);
 assert.equal(sent.length,2);
 assert.equal(new Set(sent.map(s=>s.headers['idempotency-key'])).size,1);
});

test('demo buyers without an account are skipped and left pending',async()=>{
 sent.length=0;logs.length=0;
 const {sessionId}=await bound(null);
 const res=await webhook(sessionId,`evt_${randomUUID()}`);
 assert.equal(res.status,200);
 const order=res.body.data!.order_id!;
 assert.equal(sent.length,0);assert.equal((await outbox(order)).delivered_at,null);
 assert.deepEqual(logs,[`order_email skipped order=${order} reason=no_recipient`]);
});

test('order email RPCs: definer lookup is narrow, ack is idempotent, only project_admin may execute',async()=>{
 const missing=await db.database.rpc('commerce_order_email',{p_order:randomUUID()});
 assert.equal(missing.error?.message,'order_not_found');
 assert.equal((await db.database.rpc('commerce_ack_order_email',{p_order:randomUUID()})).error?.message,'event_not_found');
 const [{id:order}]=await sql<{id: string}>(`SELECT o.id FROM commerce_orders o JOIN commerce_outbox e
  ON e.kind='order.confirmed' AND e.aggregate_id=o.id WHERE e.delivered_at IS NOT NULL LIMIT 1`);
 const before=(await outbox(order)).delivered_at;
 const acked=await db.database.rpc('commerce_ack_order_email',{p_order:order});
 assert.equal(acked.error,null);
 assert.deepEqual((await outbox(order)).delivered_at,before);
 const target=(await db.database.rpc('commerce_order_email',{p_order:order})).data as Row;
 assert.deepEqual(Object.keys(target).sort(),['buyer_id','delivered','email','order_id','reservation_id']);
 assert.equal(target.delivered,true);
 // anon=false also rules out a PUBLIC grant, which every role would inherit.
 const grants=await sql<{fn: string; definer: boolean; admin: boolean; anon: boolean; authed: boolean}>(`
  SELECT p.proname AS fn, p.prosecdef AS definer,
   has_function_privilege('project_admin',p.oid,'EXECUTE') AS admin, has_function_privilege('anon',p.oid,'EXECUTE') AS anon,
   has_function_privilege('authenticated',p.oid,'EXECUTE') AS authed
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('commerce_order_email','commerce_ack_order_email') ORDER BY p.proname`);
 assert.deepEqual(grants,[
  {fn:'commerce_ack_order_email',definer:false,admin:true,anon:false,authed:false},
  {fn:'commerce_order_email',definer:true,admin:true,anon:false,authed:false}]);
});
