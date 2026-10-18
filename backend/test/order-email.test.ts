import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { Commerce } from '../src/commerce.ts';
import type { ReservationStatusView } from '../src/commerce.ts';
import { OrderEmail, orderEmailFromEnv, renderOrderEmail } from '../src/order-email.ts';
import type { Db, PaymentResult } from '../src/types.ts';
// No network: Stripe signing is local and Primitive is a fake fetch.
const stub=<T,>(value: unknown)=>value as T;
const ORDER='0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',RESERVATION='reservation-1',BUYER='buyer-1';
const API_KEY='prim_unit_test_only',FROM='orders@exchangent.primitive.email',TO='buyer@example.test';
const reservation={id:RESERVATION,buyer_id:BUYER,stripe_session_id:'cs_test_1',total_cents:36500,currency:'usd'};
const session={id:'cs_test_1',livemode:false,mode:'payment',metadata:{reservation_id:RESERVATION},
 client_reference_id:RESERVATION,amount_total:36500,currency:'usd',payment_status:'paid',status:'complete'};
const view: ReservationStatusView={reservation_id:RESERVATION,status:'consumed',total_cents:36500,currency:'usd',
 seller:{id:'seller-1',name:'Bay Desk Co'},items:[{title:'Standing desk',quantity:1,unit_cents:20000},{title:'Task chair',quantity:2,unit_cents:7000}],
 subtotal_cents:34000,delivery_cents:2500,tax_cents:0,expires_at:'2026-10-17T00:00:00Z',
 order:{id:ORDER,status:'confirmed',total_cents:36500,currency:'usd',created_at:'2026-10-17T00:00:00Z'}};
const secret='whsec_unit_test_only',stripe=new Stripe('sk_test_fixture');
const event=(id='evt_test_1',type='checkout.session.completed')=>JSON.stringify({id,livemode:false,type,data:{object:{id:session.id}}});
const signed=(raw: string)=>stripe.webhooks.generateTestHeaderString({payload:raw,secret});

interface Sent { url: string; headers: Record<string,string>; body: Record<string,unknown> }
type Reply={status: number; body: unknown} | Error;
/** In-memory stand-ins for commerce_apply_payment, the order.confirmed outbox row and Primitive. */
function harness({email=TO as string | null,replies=[] as Reply[]}={}) {
 const events=new Set<string>(),sent: Sent[]=[],logs: string[]=[],rpcs: string[]=[];
 const outbox={delivered:false};
 const db=stub<Db>({database:{
  async rpc(name: string,args: Record<string,unknown>) {
   rpcs.push(name);
   if(name==='commerce_apply_payment') {
    if(events.has(args.p_event as string)) return {data:{duplicate:true},error:null};
    events.add(args.p_event as string);return {data:{duplicate:false,order_id:ORDER,confirmed:true},error:null};
   }
   if(name==='commerce_order_email') return {data:{order_id:ORDER,reservation_id:RESERVATION,buyer_id:BUYER,email,delivered:outbox.delivered},error:null};
   if(name==='commerce_ack_order_email') {outbox.delivered=true;return {data:{order_id:ORDER},error:null};}
   return {data:null,error:{message:'unexpected_rpc'}};
  },
  from:(table: string)=>({select:()=>({eq:()=>({limit:async()=>({data:table==='commerce_orders'?[{id:ORDER}]:[],error:null})})})}),
 }});
 const fetch=stub<typeof globalThis.fetch>(async(url: string,init: RequestInit)=>{
  sent.push({url,headers:init.headers as Record<string,string>,body:JSON.parse(init.body as string)});
  const reply=replies.shift()??{status:200,body:{success:true,data:{id:'sent-1',status:'queued'}}};
  if(reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body),{status:reply.status,headers:{'content-type':'application/json'}});
 });
 const orderEmail=new OrderEmail({db,apiKey:API_KEY,from:FROM,fetch,log:line=>logs.push(line)});
 const c=new Commerce({db,stripe:stub<Stripe>({webhooks:stripe.webhooks,checkout:{sessions:{retrieve:async()=>session}}}),
  webhookSecret:secret,baseUrl:'http://localhost',integrationId:'test',orderEmail});
 c.row=async<T,>()=>reservation as T;
 const receipts: string[][]=[];
 c.status=async(buyer: string,id: string)=>{receipts.push([buyer,id]);return view;};
 const webhook=(raw=event())=>c.webhook(raw,signed(raw)) as Promise<PaymentResult>;
 return {c,webhook,sent,logs,rpcs,outbox,receipts};
}

test('order email is disabled unless both Primitive variables are set',async()=>{
 const db=stub<Db>({database:{}});
 assert.equal(orderEmailFromEnv(db,{}),undefined);
 assert.equal(orderEmailFromEnv(db,{PRIMITIVE_API_KEY:API_KEY}),undefined);
 assert.equal(orderEmailFromEnv(db,{PRIMITIVE_FROM:FROM}),undefined);
 assert.equal(orderEmailFromEnv(db,{PRIMITIVE_API_KEY:' ',PRIMITIVE_FROM:FROM}),undefined);
 assert.ok(orderEmailFromEnv(db,{PRIMITIVE_API_KEY:API_KEY,PRIMITIVE_FROM:FROM}) instanceof OrderEmail);
 // A Commerce without an order email only applies the payment.
 const {c,rpcs,webhook}=harness();
 c.orderEmail=undefined;
 assert.deepEqual(await webhook(),{duplicate:false,order_id:ORDER,confirmed:true});
 assert.deepEqual(rpcs,['commerce_apply_payment']);
});

test('a confirmed payment sends one receipt email through Primitive and acks the outbox row',async()=>{
 const {webhook,sent,outbox,receipts,rpcs}=harness();
 assert.deepEqual(await webhook(),{duplicate:false,order_id:ORDER,confirmed:true});
 assert.equal(sent.length,1);assert.equal(outbox.delivered,true);
 assert.deepEqual(receipts,[[BUYER,RESERVATION]]);
 assert.deepEqual(rpcs,['commerce_apply_payment','commerce_order_email','commerce_ack_order_email']);
 const [{url,headers,body}]=sent;
 assert.equal(url,'https://api.primitive.dev/v1/send-mail');
 assert.equal(headers.authorization,`Bearer ${API_KEY}`);
 assert.equal(headers['idempotency-key'],`exchangent-order-confirmed-${ORDER}`);
 assert.equal(body.from,FROM);assert.equal(body.to,TO);
 assert.equal(body.subject,'Order confirmed: Bay Desk Co, $365.00');
 for(const part of ['Seller: Bay Desk Co',`Order: ${ORDER}`,'1 × Standing desk: $200.00','2 × Task chair: $140.00',
  'Subtotal: $340.00','Delivery: $25.00','Total paid: $365.00']) assert.ok((body.body_text as string).includes(part),part);
 assert.ok((body.body_html as string).includes('Bay Desk Co'));
 assert.deepEqual(body.tags,[{name:'category',value:'order_confirmation'},{name:'order_id',value:ORDER}]);
});

test('a retried or second Stripe event never sends a second email',async()=>{
 const {webhook,sent}=harness();
 await webhook();
 // Same event again (Stripe retry): duplicate, no order_id; the order is looked up and already delivered.
 assert.deepEqual(await webhook(),{duplicate:true});
 // A different event for the same paid session.
 await webhook(event('evt_test_2','checkout.session.async_payment_succeeded'));
 assert.equal(sent.length,1);
});

test('a failed send never fails the webhook, stays pending, and a retry sends it once',async()=>{
 const denied={status:403,body:{success:false,error:{code:'recipient_not_allowed',message:`cannot send to ${TO}`}}};
 const {webhook,sent,logs,outbox}=harness({replies:[denied,new TypeError('fetch failed')]});
 assert.deepEqual(await webhook(),{duplicate:false,order_id:ORDER,confirmed:true});
 assert.equal(outbox.delivered,false);
 assert.deepEqual(await webhook(),{duplicate:true});
 assert.equal(outbox.delivered,false);
 assert.deepEqual(logs,[`order_email failed order=${ORDER} reason=primitive_403_recipient_not_allowed`,
  `order_email failed order=${ORDER} reason=TypeError`]);
 for(const line of logs) {assert.ok(!line.includes(TO));assert.ok(!line.includes(API_KEY));}
 // Third delivery of the event: Primitive accepts; every attempt used the same idempotency key.
 await webhook();
 assert.equal(outbox.delivered,true);assert.equal(sent.length,3);
 assert.equal(new Set(sent.map(s=>s.headers['idempotency-key'])).size,1);
 await webhook();assert.equal(sent.length,3);
});

test('database or receipt errors are contained too; buyers without an email are skipped',async()=>{
 const broken=harness();
 broken.c.status=async()=>{throw new Error('boom');};
 assert.deepEqual(await broken.webhook(),{duplicate:false,order_id:ORDER,confirmed:true});
 assert.equal(broken.sent.length,0);assert.equal(broken.outbox.delivered,false);
 const lookupFails=harness();
 lookupFails.c.orderEmail={deliver:async()=>{throw new Error('unexpected');}};
 assert.deepEqual(await lookupFails.webhook(),{duplicate:false,order_id:ORDER,confirmed:true});
 const demo=harness({email:null});
 await demo.webhook();
 assert.equal(demo.sent.length,0);assert.equal(demo.outbox.delivered,false);
 assert.deepEqual(demo.logs,[`order_email skipped order=${ORDER} reason=no_recipient`]);
});

test('unpaid sessions do not send; rendered email escapes seller-provided names',async()=>{
 const {c,sent,rpcs}=harness();
 c.stripe=stub<Stripe>({webhooks:stripe.webhooks,checkout:{sessions:{retrieve:async()=>({...session,payment_status:'unpaid'})}}});
 const raw=event();await c.webhook(raw,signed(raw));
 assert.equal(sent.length,0);assert.deepEqual(rpcs,['commerce_apply_payment']);
 const r=renderOrderEmail(ORDER,{...view,seller:{id:'s',name:'Evil <script>\r\nBcc: x'},items:[{title:'<b>Desk</b>',quantity:1,unit_cents:34000}]});
 assert.ok(!r.html.includes('<script>'));assert.ok(!r.html.includes('<b>Desk'));
 assert.ok(!/[\r\n]/.test(r.subject));
 assert.equal(renderOrderEmail(ORDER,view).text,renderOrderEmail(ORDER,view).text);
});
