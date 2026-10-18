// Real-database checks for orders, cases, refunds and chargebacks (migrations/20261018000900_resolution.sql,
// src/resolution.ts, src/disputes.ts). Run with `npm run test:db`. Orders are paid through the real Stripe
// webhook path with a fake Stripe (refunds and disputes recorded); every test uses its own order.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { QueryResultRow } from 'pg';
import Stripe from 'stripe';
import { pgDb } from '../../scripts/pg-db.ts';
import { Commerce, CommerceError } from '../../src/commerce.ts';
import { Negotiation, hashToken } from '../../src/negotiation.ts';
import { createApp } from '../../src/server.ts';
import type { AppOptions } from '../../src/server.ts';
import type { ApiError, ReservationRow, Row } from '../../src/types.ts';

assert.ok(process.env.DATABASE_URL,'DATABASE_URL is required (use npm run test:db)');
const db=pgDb(process.env.DATABASE_URL);
const sql=async<T extends QueryResultRow=Row>(text: string,params?: unknown[])=>(await db.pool.query<T>(text,params)).rows;
const secret='whsec_resolution_db',signer=new Stripe('sk_test_fixture');

// ---------- fake Stripe ----------
const sessions=new Map<string,Record<string,unknown>>();
const refundCalls: {params: {payment_intent: string; amount: number}; key?: string}[]=[];
const disputeCalls: {op: 'update'|'close'; id: string; params?: {evidence?: Record<string,string>; submit?: boolean}}[]=[];
let refundMode: 'succeeded'|'pending'|'throw'='succeeded';
const stripe={webhooks:signer.webhooks,
 checkout:{sessions:{retrieve:async(id: string)=>sessions.get(id),
  list:async(p: {payment_intent?: string})=>({data:[...sessions.values()].filter(s=>s.payment_intent===p.payment_intent)})}},
 refunds:{create:async(params: {payment_intent: string; amount: number},o: {idempotencyKey?: string})=>{
  refundCalls.push({params,key:o?.idempotencyKey});
  if(refundMode==='throw') throw Object.assign(new Error('card_declined'),{type:'StripeCardError'});
  return {id:`re_${(o?.idempotencyKey??randomUUID()).replace(/[^a-z0-9]/gi,'').slice(-20)}`,status:refundMode,amount:params.amount};
 }},
 disputes:{update:async(id: string,params: {evidence?: Record<string,string>; submit?: boolean})=>{disputeCalls.push({op:'update',id,params});return {id,status:'under_review'};},
  close:async(id: string)=>{disputeCalls.push({op:'close',id});return {id,status:'lost'};}},
};

// ---------- people, tokens and a business ----------
const BUYER_SESSION='Bearer user-session-res-buyer',OWNER_SESSION='Bearer user-session-res-owner',OTHER_SESSION='Bearer user-session-res-other';
const buyerUser={id:randomUUID(),email:'Res.Buyer@example.test'},ownerUser={id:randomUUID(),email:'res.owner@example.test'};
const otherUser={id:randomUUID(),email:'res.other@example.test'};
let server: ReturnType<typeof createApp>,base: string;
const T: Record<string,string>={};
let buyer: string,owner: string,other: string,seller: string,otherSeller: string;
const inv: Record<string,string>={};
async function token(name: string,actor: string,scope: string,sellerId: string | null,label: string) {
 const t=randomBytes(32).toString('hex');
 await sql(`INSERT INTO commerce_principals(token_hash,actor_id,scope,seller_id,label,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 hour')`,
  [hashToken(t),actor,scope,sellerId,label]);
 T[name]=t;
}
before(async()=>{
 for(const u of [buyerUser,ownerUser,otherUser]) await sql('INSERT INTO auth.users(id,email) VALUES($1,$2)',[u.id,u.email]);
 const actor=async(user: string | null,label: string)=>(await sql<{id: string}>('INSERT INTO commerce_actors(auth_user_id,label) VALUES($1,$2) RETURNING id',[user,label]))[0].id;
 buyer=await actor(buyerUser.id,'Exchangent user');owner=await actor(ownerUser.id,'Exchangent user');other=await actor(otherUser.id,'Exchangent user');
 const platform=await actor(null,'res platform');
 seller=(await sql<{id: string}>(`INSERT INTO commerce_sellers(owner_id,name,service_area,delivery_cents,delivery_days) VALUES($1,$2,'res_town',2500,1) RETURNING id`,
  [owner,`Resolution Desks ${randomUUID().slice(0,6)}`]))[0].id;
 otherSeller=(await sql<{id: string}>(`INSERT INTO commerce_sellers(owner_id,name,service_area) VALUES($1,$2,'res_town') RETURNING id`,
  [other,`Other Shop ${randomUUID().slice(0,6)}`]))[0].id;
 const add=async(k: string,category: string,attrs: object,floor: number,available=50)=>{
  inv[k]=(await sql<{id: string}>(`INSERT INTO commerce_inventory(seller_id,sku,title,floor_cents,available,list_cents,category,attributes)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[seller,k,`${k} title`,floor,available,floor*2,category,JSON.stringify(attrs)]))[0].id;
 };
 await add('desk46','desk',{width_in:46},15000);await add('chair','chair',{ergonomic:true},10000);
 await add('desk48','desk',{width_in:48},12000,5);await add('desk60','desk',{width_in:60},12000,5);await add('pricey48','desk',{width_in:48},19000,5);
 await token('buyer',buyer,'buyer',null,'res buyer');await token('agent',platform,'buyer_agent',null,'agents:buyer-agent');
 await token('owner',owner,'seller',seller,'res owner');await token('sellerAgent',owner,'seller',seller,`agents:seller-agent:${seller}`);
 await token('otherSeller',other,'seller',otherSeller,'other owner');await token('worker',platform,'worker',null,'agents:worker');
 const commerce=new Commerce({db,stripe:stripe as unknown as Stripe,webhookSecret:secret,baseUrl:'http://127.0.0.1',integrationId:'test'});
 const users: Record<string,{id: string; actor: string; email: string}>={[BUYER_SESSION]:{id:buyerUser.id,actor:buyer,email:buyerUser.email},
  [OWNER_SESSION]:{id:ownerUser.id,actor:owner,email:ownerUser.email},[OTHER_SESSION]:{id:otherUser.id,actor:other,email:otherUser.email}};
 const auth={authenticate:async(header?: string)=>{
  const u=header?users[header]:undefined;
  if(!u) throw new CommerceError('unauthorized',401);
  return {kind:'user',actorId:u.actor,userId:u.id,email:u.email};
 }} as unknown as AppOptions['auth'];
 server=createApp({commerce,negotiation:new Negotiation({db}),auth});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async()=>{
 await sql('UPDATE commerce_sellers SET enabled=false WHERE id=ANY($1)',[[seller,otherSeller]]);
 await sql("UPDATE commerce_outbox SET delivered_at=now() WHERE delivered_at IS NULL AND kind<>'order.confirmed'");
 server?.close();await db.end();
});

// ---------- HTTP helpers ----------
interface Reply { status: number; body: {data?: unknown; error?: ApiError} }
async function call(method: string,path: string,auth?: string,body?: unknown,key?: string): Promise<Reply> {
 const headers: Record<string,string>={};
 if(auth) headers.authorization=auth.startsWith('Bearer ')?auth:`Bearer ${auth}`;
 if(key) headers['idempotency-key']=key;
 if(body!==undefined) headers['content-type']='application/json';
 const res=await fetch(base+'/api/v1'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:res.status,body:await res.json() as Reply['body']};
}
const ok=<T=Record<string,unknown>,>(r: Reply)=>{assert.ok(r.body.data!==undefined,JSON.stringify(r.body));return r.body.data as T;};
const err=(r: Reply,code: string,status: number)=>{assert.equal(r.body.error?.code,code,JSON.stringify(r.body));assert.equal(r.status,status);};
async function stripeEvent(type: string,object: Record<string,unknown>) {
 const raw=JSON.stringify({id:`evt_${randomUUID()}`,livemode:false,type,data:{object}});
 const res=await fetch(`${base}/webhooks/stripe`,{method:'POST',body:raw,
  headers:{'content-type':'application/json','stripe-signature':signer.webhooks.generateTestHeaderString({payload:raw,secret})}});
 return {status:res.status,body:await res.json() as {data?: Record<string,unknown>; error?: ApiError}};
}
const rpc=async<T,>(name: string,args: Record<string,unknown>)=>{const {data,error}=await db.database.rpc(name,args);assert.equal(error,null,JSON.stringify(error));return data as T;};

/** A paid order for the test buyer: a 46in desk ($150 + $50 margin) and a chair, $25 delivery. */
async function paidOrder({delegated=true,lines=[['desk46',20000],['chair',15000]] as [string,number][],buyerId=buyer}={}) {
 const requirements={region:'res_town',deliver_by:'2099-01-01',items:[{category:'desk',max_width_in:48},{category:'chair',ergonomic:true}]};
 const [{id:request}]=await sql<{id: string}>(`INSERT INTO commerce_requests(buyer_id,budget_cents,title,structured_requirements,delegate_negotiation)
  VALUES($1,60000,'Desk and chair',$2,$3) RETURNING id`,[buyerId,JSON.stringify(requirements),delegated]);
 const [{id:offer}]=await sql<{id: string}>(`INSERT INTO commerce_offers(request_id,seller_id,version,delivery_cents,tax_cents,expires_at)
  VALUES($1,$2,1,2500,0,now()+interval '1 hour') RETURNING id`,[request,seller]);
 for(const [k,cents] of lines) await sql('INSERT INTO commerce_offer_items VALUES($1,$2,1,$3)',[offer,inv[k],cents]);
 const r=await rpc<ReservationRow>('commerce_reserve',{p_buyer:buyerId,p_offer:offer,p_key:randomUUID()});
 await rpc('commerce_begin_checkout',{p_buyer:buyerId,p_reservation:r.id});
 const sessionId=`cs_test_${randomUUID().replaceAll('-','')}`;
 await rpc('commerce_bind_checkout',{p_reservation:r.id,p_session:sessionId,p_url:'https://checkout.stripe.test'});
 const pi=`pi_test_${randomUUID().replaceAll('-','')}`;
 sessions.set(sessionId,{id:sessionId,livemode:false,mode:'payment',client_reference_id:r.id,metadata:{reservation_id:r.id},
  amount_total:r.total_cents,currency:'usd',payment_status:'paid',status:'complete',payment_intent:pi});
 const paid=await stripeEvent('checkout.session.completed',{id:sessionId});
 assert.equal(paid.status,200,JSON.stringify(paid.body));
 const [{id:order}]=await sql<{id: string}>('SELECT id FROM commerce_orders WHERE reservation_id=$1',[r.id]);
 return {order,request,reservation:r.id,total:r.total_cents,pi,sessionId};
}
interface CaseJson { case_id: string; status: string; turn: string | null; version: number; rounds: number; type: string;
 resolution: Record<string,unknown> | null; remedy: Record<string,unknown> | null; refunds: {status: string; amount_cents: number}[];
 substitute_check?: Record<string,unknown> | null; moves: {action: string; by: string}[]; requested_remedy?: unknown; policy?: unknown;
 refundable_cents: number; total_cents: number }
const order=async(id: string)=>(await sql<{status: string; refunded_cents: number; stripe_payment_intent: string | null}>(
 'SELECT status,refunded_cents,stripe_payment_intent FROM commerce_orders WHERE id=$1',[id]))[0];
const stock=async(k: string)=>(await sql<{available: number; sold: number}>('SELECT available,sold FROM commerce_inventory WHERE id=$1',[inv[k]]))[0];
const resEvents=async()=>ok<{id: string; kind: string; route: Record<string,unknown>; payload: Record<string,unknown>}[]>(
 await call('GET','/worker/events?limit=100&include=resolution',T.worker));
const drainRes=async()=>{for(const e of await resEvents()) if(e.route?.order_id) await call('POST',`/worker/events/${e.id}/ack`,T.worker,{});};

test('fulfilment: ship, simulated delivery, buyer confirmation; receipts keep saying confirmed',async()=>{
 const a=await paidOrder();
 err(await call('POST',`/seller/orders/${a.order}/ship`,T.sellerAgent,{carrier:'UPS',tracking:'1Z'}),'forbidden',403);
 err(await call('POST',`/seller/orders/${a.order}/ship`,T.otherSeller,{carrier:'UPS',tracking:'1Z'}),'forbidden',403);
 err(await call('POST',`/seller/orders/${a.order}/ship`,T.owner,{carrier:'UPS'}),'invalid_input',400);
 const shipped=ok(await call('POST',`/seller/orders/${a.order}/ship`,T.owner,{carrier:'UPS',tracking:'1Z999'}));
 assert.equal(shipped.status,'shipped');assert.equal(shipped.carrier,'UPS');
 err(await call('POST',`/seller/orders/${a.order}/ship`,T.owner,{carrier:'UPS',tracking:'1Z999'}),'order_not_shippable',409);
 const ev=(await resEvents()).find(e=>e.kind==='order.shipped'&&e.route.order_id===a.order);
 assert.ok(ev,'order.shipped event for the buyer');assert.equal(ev.route.to_role,'buyer');
 assert.equal(ev.payload.tracking,'1Z999');assert.equal(ev.payload.request_id,a.request);assert.equal(ev.payload.title,'Desk and chair');
 // The default feed (older runners) never shows resolution events.
 const plain=ok<{id: string}[]>(await call('GET','/worker/events?limit=100',T.worker));
 assert.ok(!plain.some(e=>e.id===ev.id));
 const acked=ok(await call('POST',`/worker/events/${ev.id}/ack`,T.worker,{delivery:{transport:'inkbox',from_handle:'exchangent-sellers',to_handle:'exchangent-buyer'}}));
 assert.equal(acked.kind,'order.shipped');
 err(await call('POST',`/worker/events/${randomUUID()}/ack`,T.worker,{}),'event_not_found',404);
 const delivered=ok(await call('POST',`/seller/orders/${a.order}/simulate-delivery`,T.owner));
 assert.equal(delivered.status,'delivered');assert.equal(delivered.simulated,true);
 assert.equal((delivered.delivery_evidence as {source: string}).source,'simulated');
 const status=ok<{order: {status: string; lifecycle_status: string}}>(await call('GET',`/reservations/${a.reservation}`,T.buyer));
 assert.deepEqual([status.order.status,status.order.lifecycle_status],['confirmed','delivered']);
 // The buyer can confirm receipt themselves; the buyer agent cannot.
 const b=await paidOrder();
 err(await call('POST',`/orders/${b.order}/received`,T.agent),'forbidden',403);
 const got=ok(await call('POST',`/orders/${b.order}/received`,T.buyer));
 assert.equal((got.delivery_evidence as {source: string}).source,'buyer_confirmed');
 // The seller's order view has no buyer identity.
 const sellerView=ok(await call('GET',`/orders/${b.order}`,T.owner));
 assert.equal(sellerView.shipping_name,'Buyer');assert.ok(!JSON.stringify(sellerView).includes(buyerUser.email.toLowerCase()));
 assert.ok(!('buyer_id' in sellerView));
 await drainRes();
});

test('not received after the promise: automatic refund through Stripe, once',async()=>{
 const a=await paidOrder();
 // Still before the promised date: the case opens for the seller to answer.
 await sql("UPDATE commerce_requests SET deadline=now()+interval '2 days' WHERE id=$1",[a.request]);
 const early=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'not_received',description:'Nothing yet'},randomUUID()));
 assert.deepEqual([early.status,early.turn],['open','seller']);
 err(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'damaged'},randomUUID()),'case_already_open',409);
 await sql("UPDATE commerce_cases SET status='closed' WHERE id=$1",[early.case_id]);
 // Past the promise plus the policy's 3 days, with no delivery recorded: refunded automatically.
 await sql("UPDATE commerce_requests SET deadline=now()-interval '5 days' WHERE id=$1",[a.request]);
 const before=refundCalls.length,key=randomUUID();
 const c=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'not_received'},key));
 assert.equal(c.status,'resolved');assert.equal(c.resolution?.how,'auto');assert.equal(c.resolution?.kind,'refund_full');
 assert.equal(refundCalls.length,before+1);
 assert.equal(refundCalls.at(-1)!.params.payment_intent,a.pi);assert.equal(refundCalls.at(-1)!.params.amount,a.total);
 assert.match(refundCalls.at(-1)!.key!,/^exchangent-refund-/);
 assert.equal(c.refunds[0].status,'succeeded');
 assert.deepEqual(await order(a.order),{status:'refunded',refunded_cents:a.total,stripe_payment_intent:a.pi});
 // A retried call with the same key returns the case and never refunds twice.
 const again=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'not_received'},key));
 assert.equal(again.case_id,c.case_id);assert.equal(refundCalls.length,before+1);
 err(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'damaged'},randomUUID()),'order_closed',409);
 const kinds=(await resEvents()).filter(e=>e.payload.case_id===c.case_id&&e.kind.startsWith('case.')).map(e=>`${e.kind}:${e.route.to_role}`).sort();
 assert.deepEqual(kinds,['case.resolved:buyer','case.resolved:seller']);
 assert.ok((await resEvents()).some(e=>e.kind==='refund.succeeded'&&e.route.order_id===a.order&&e.payload.refund_id));
 await drainRes();
});

test('late delivery: automatic delivery-fee credit; buyer views never show the seller policy',async()=>{
 const a=await paidOrder();
 ok(await call('POST',`/seller/orders/${a.order}/ship`,T.owner,{carrier:'UPS',tracking:'1ZLATE'}));
 ok(await call('POST',`/seller/orders/${a.order}/simulate-delivery`,T.owner));
 await sql("UPDATE commerce_requests SET deadline=now()-interval '1 day' WHERE id=$1",[a.request]);
 const c=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'late'},randomUUID()));
 assert.deepEqual([c.status,c.resolution?.kind,c.resolution?.amount_cents],['resolved','sla_credit',2500]);
 assert.ok(!('policy' in c),'buyer view has no policy');
 const sellerCase=ok<CaseJson>(await call('GET',`/cases/${c.case_id}`,T.owner));
 assert.ok(sellerCase.policy,'seller view has the policy');
 assert.deepEqual(await order(a.order),{status:'delivered',refunded_cents:2500,stripe_payment_intent:a.pi});
 await drainRes();
});

test('duplicate charge: the newer order is cancelled, restocked and refunded',async()=>{
 // A total no other test uses, so only this pair counts as a duplicate.
 const lines: [string,number][]=[['desk46',20123],['chair',15000]];
 const first=await paidOrder({lines}),second=await paidOrder({lines});
 const desk=await stock('desk46');
 const c=ok<CaseJson>(await call('POST',`/orders/${first.order}/cases`,T.buyer,{type:'duplicate_charge'},randomUUID()));
 assert.equal(c.status,'resolved');assert.equal(c.resolution?.order_id,second.order);
 assert.equal((await order(second.order)).status,'cancelled');assert.equal((await order(second.order)).refunded_cents,second.total);
 assert.equal((await order(first.order)).status,'confirmed');
 assert.equal((await stock('desk46')).available,desk.available+1);
 await drainRes();
});

test('changed mind: cancel before shipping, return within the window, declined after it',async()=>{
 const a=await paidOrder(),desk=await stock('desk46');
 const cancel=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'changed_mind'},randomUUID()));
 assert.deepEqual([cancel.resolution?.kind,cancel.resolution?.how],['cancel','policy']);
 assert.deepEqual(await order(a.order),{status:'cancelled',refunded_cents:a.total,stripe_payment_intent:a.pi});
 assert.equal((await stock('desk46')).available,desk.available+1);

 const b=await paidOrder();
 ok(await call('POST',`/seller/orders/${b.order}/ship`,T.owner,{carrier:'UPS',tracking:'1ZRET'}));
 ok(await call('POST',`/seller/orders/${b.order}/simulate-delivery`,T.owner));
 const ret=ok<CaseJson>(await call('POST',`/orders/${b.order}/cases`,T.buyer,{type:'changed_mind',items:[{inventory_id:inv.chair}]},randomUUID()));
 assert.deepEqual([ret.resolution?.kind,ret.resolution?.amount_cents,ret.resolution?.return_shipping_paid_by],['return_for_refund',15000,'buyer']);
 assert.equal(ret.refunds.length,0,'refunded only when the return arrives');
 err(await call('POST',`/cases/${ret.case_id}/return-received`,T.sellerAgent),'forbidden',403);
 const chair=await stock('chair');
 const back=ok<CaseJson>(await call('POST',`/cases/${ret.case_id}/return-received`,T.owner,undefined,randomUUID()));
 assert.equal(back.refunds[0].amount_cents,15000);assert.equal(back.refunds[0].status,'succeeded');
 assert.equal((await stock('chair')).available,chair.available+1);
 assert.equal((await order(b.order)).refunded_cents,15000);

 const c=await paidOrder();
 ok(await call('POST',`/seller/orders/${c.order}/ship`,T.owner,{carrier:'UPS',tracking:'1ZOLD'}));
 ok(await call('POST',`/seller/orders/${c.order}/simulate-delivery`,T.owner));
 await sql("UPDATE commerce_orders SET delivered_at=now()-interval '30 days' WHERE id=$1",[c.order]);
 const late=ok<CaseJson>(await call('POST',`/orders/${c.order}/cases`,T.buyer,{type:'changed_mind'},randomUUID()));
 assert.deepEqual([late.status,late.resolution?.kind],['closed','decline']);
 await drainRes();
});

test('remedy negotiation: policy auto-accept, counters, accept with a Stripe refund, buyer agent, round cap',async()=>{
 // Within the seller's 15% auto-approve: accepted under policy.
 const a=await paidOrder();
 const small=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'damaged',
  requested_remedy:{kind:'keep_with_discount',amount_cents:5000},evidence:[{kind:'photo',ref:'https://img.test/scratch.jpg'}]},randomUUID()));
 assert.deepEqual([small.status,small.resolution?.how,small.resolution?.amount_cents],['resolved','policy',5000]);

 // Above it: the seller answers, they settle at 20%.
 const b=await paidOrder();
 const c=ok<CaseJson>(await call('POST',`/orders/${b.order}/cases`,T.buyer,{type:'damaged',description:'Deep scratch on the desk top',
  requested_remedy:{kind:'refund_partial',amount_cents:18750}},randomUUID()));
 assert.deepEqual([c.status,c.turn,c.version],['open','seller',1]);
 assert.deepEqual((c.requested_remedy as {amount_cents: number}).amount_cents,18750);
 assert.equal(c.total_cents,b.total);assert.equal(c.refundable_cents,b.total);
 const opened=(await resEvents()).find(e=>e.kind==='case.opened'&&e.payload.case_id===c.case_id);
 assert.equal(opened?.route.to_role,'seller');assert.equal(opened?.route.seller_delegated,true);
 err(await call('POST',`/cases/${c.case_id}/respond`,T.buyer,{expected_version:1,action:'accept'}),'not_your_turn',409);
 err(await call('POST',`/cases/${c.case_id}/respond`,T.owner,{expected_version:9,action:'accept'}),'stale_case',409);
 err(await call('POST',`/cases/${c.case_id}/respond`,T.otherSeller,{expected_version:1,action:'accept'}),'forbidden',403);
 const s1=ok<CaseJson>(await call('POST',`/cases/${c.case_id}/respond`,T.sellerAgent,{expected_version:1,action:'counter',
  remedy:{kind:'keep_with_discount',amount_cents:5000},note:'Sorry about that.'},randomUUID()));
 assert.deepEqual([s1.turn,s1.version,s1.rounds],['buyer',2,1]);
 // The platform buyer agent answers for a delegated request.
 const b1=ok<CaseJson>(await call('POST',`/cases/${c.case_id}/respond`,T.agent,{expected_version:2,action:'counter',
  remedy:{kind:'keep_with_discount',amount_cents:7500}},randomUUID()));
 assert.equal(b1.turn,'seller');
 const before=refundCalls.length;
 const done=ok<CaseJson>(await call('POST',`/cases/${c.case_id}/respond`,T.owner,{expected_version:3,action:'accept'},randomUUID()));
 assert.deepEqual([done.status,done.resolution?.how,done.resolution?.amount_cents],['resolved','agreed',7500]);
 assert.equal(refundCalls.length,before+1);assert.equal(refundCalls.at(-1)!.params.amount,7500);
 assert.equal((await order(b.order)).refunded_cents,7500);
 err(await call('POST',`/cases/${c.case_id}/respond`,T.buyer,{expected_version:4,action:'accept'}),'case_closed',409);

 // The buyer agent cannot act on an order whose buyer kept negotiation for themselves.
 const p=await paidOrder({delegated:false});
 const own=ok<CaseJson>(await call('POST',`/orders/${p.order}/cases`,T.buyer,{type:'wrong_item'},randomUUID()));
 err(await call('GET',`/cases/${own.case_id}`,T.agent),'forbidden',403);
 err(await call('POST',`/orders/${p.order}/cases`,T.agent,{type:'damaged'}),'forbidden',403);
 // Six counters, then the round cap escalates to a person.
 let v=1,turn=T.owner;
 for(let i=0;i<6;i++) {
  const r=ok<CaseJson>(await call('POST',`/cases/${own.case_id}/respond`,turn,{expected_version:v,action:'counter',
   remedy:{kind:'refund_partial',amount_cents:1000+i*500}}));
  v=r.version;turn=turn===T.owner?T.buyer:T.owner;
 }
 const capped=ok<CaseJson>(await call('POST',`/cases/${own.case_id}/respond`,turn,{expected_version:v,action:'counter',
  remedy:{kind:'refund_partial',amount_cents:9000}}));
 assert.equal(capped.status,'escalated');
 assert.equal((await resEvents()).filter(e=>e.kind==='case.escalated'&&e.payload.case_id===own.case_id).length,2);
 // Remedy amounts are capped at what is still refundable, and garbage is rejected.
 const q=await paidOrder();
 const big=ok<CaseJson>(await call('POST',`/orders/${q.order}/cases`,T.buyer,{type:'damaged',requested_remedy:{kind:'refund_partial',amount_cents:99999999}}));
 assert.equal((big.remedy as {amount_cents: number}).amount_cents,q.total);
 err(await call('POST',`/cases/${big.case_id}/respond`,T.owner,{expected_version:1,action:'counter',remedy:{kind:'bitcoin'}}),'invalid_input',400);
 err(await call('POST',`/orders/${q.order}/cases`,T.buyer,{type:'nope'}),'invalid_input',400);
 err(await call('POST',`/orders/${q.order}/cases`,T.buyer,{type:'damaged'}),'case_already_open',409);
 await drainRes();
});

test('a failed Stripe refund is recorded, reported and retried with the same idempotency key',async()=>{
 const a=await paidOrder();
 refundMode='throw';
 const r=await call('POST',`/orders/${a.order}/cases`,T.buyer,{type:'damaged',requested_remedy:{kind:'keep_with_discount',amount_cents:3000}},randomUUID());
 err(r,'refund_failed',502);
 const [f]=await sql<{id: string; status: string}>('SELECT id,status FROM commerce_refunds WHERE order_id=$1',[a.order]);
 assert.equal(f.status,'failed');assert.equal((await order(a.order)).refunded_cents,0);
 refundMode='succeeded';
 err(await call('POST',`/refunds/${f.id}/retry`,T.otherSeller),'forbidden',403);
 const keys=refundCalls.filter(c=>c.key===`exchangent-refund-${f.id}`).length;
 assert.deepEqual(ok(await call('POST',`/refunds/${f.id}/retry`,T.buyer)),{refund_id:f.id,status:'succeeded'});
 assert.equal(refundCalls.filter(c=>c.key===`exchangent-refund-${f.id}`).length,keys+1);
 assert.equal((await order(a.order)).refunded_cents,3000);
 // Stripe can also accept a refund as pending; charge.refunded settles it.
 const b=await paidOrder();
 refundMode='pending';
 const c=ok<CaseJson>(await call('POST',`/orders/${b.order}/cases`,T.buyer,{type:'damaged',requested_remedy:{kind:'keep_with_discount',amount_cents:2000}}));
 refundMode='succeeded';
 assert.equal(c.refunds[0].status,'pending');
 const settled=await stripeEvent('charge.refunded',{id:'ch_test',object:'charge',payment_intent:b.pi,amount_refunded:2000});
 assert.equal(settled.status,200);assert.equal(settled.body.data?.reconciled,1);
 assert.equal((await order(b.order)).refunded_cents,2000);
 await drainRes();
});

test('out of stock: a substitute is checked against the original requirements, then swapped',async()=>{
 const a=await paidOrder(),d46=await stock('desk46'),d48=await stock('desk48');
 err(await call('POST',`/seller/orders/${a.order}/issue`,T.owner,{kind:'out_of_stock',substitute:{replaces:inv.desk46,inventory_id:inv.desk48,unit_cents:25000}}),
  'price_increase_not_allowed',409);
 err(await call('POST',`/seller/orders/${a.order}/issue`,T.owner,{kind:'out_of_stock',substitute:{replaces:inv.desk46,inventory_id:inv.desk48,unit_cents:100}}),
  'below_floor',409);
 const c=ok<CaseJson>(await call('POST',`/seller/orders/${a.order}/issue`,T.owner,{kind:'out_of_stock',
  substitute:{replaces:inv.desk46,inventory_id:inv.desk48,unit_cents:17000},note:'Sold out of 46in; 48in at a lower price.'},randomUUID()));
 assert.deepEqual([c.type,c.turn,c.status],['substitution','buyer','open']);
 const check=c.substitute_check as {meets_requirements: boolean; unit_cents_delta: number};
 assert.deepEqual([check.meets_requirements,check.unit_cents_delta],[true,-3000]);
 assert.equal((c.remedy as {amount_cents: number}).amount_cents,3000);
 const opened=(await resEvents()).find(e=>e.kind==='case.opened'&&e.payload.case_id===c.case_id);
 assert.equal(opened?.route.to_role,'buyer');assert.equal(opened?.route.delegated,true);
 const done=ok<CaseJson>(await call('POST',`/cases/${c.case_id}/respond`,T.agent,{expected_version:1,action:'accept'},randomUUID()));
 assert.equal(done.status,'resolved');
 const items=await sql<{inventory_id: string; title: string; unit_cents: number}>(
  'SELECT inventory_id,title,unit_cents FROM commerce_reservation_items WHERE reservation_id=$1 ORDER BY title',[a.reservation]);
 assert.ok(items.some(i=>i.inventory_id===inv.desk48&&i.unit_cents===20000),'swapped line keeps the paid price');
 assert.ok(!items.some(i=>i.inventory_id===inv.desk46));
 assert.equal((await stock('desk48')).available,d48.available-1);assert.equal((await stock('desk46')).sold,d46.sold-1);
 assert.equal((await order(a.order)).refunded_cents,3000,'the cheaper substitute refunds the difference');
 // The receipt still adds up after the swap.
 const status=ok<{items: {title: string}[]; order: {status: string}}>(await call('GET',`/reservations/${a.reservation}`,T.buyer));
 assert.ok(status.items.some(i=>i.title==='desk48 title'));assert.equal(status.order.status,'confirmed');
 // Same price, `replaces` defaulted from the one affected item: accepting moves no money.
 const sp=await paidOrder();
 const same=ok<CaseJson>(await call('POST',`/seller/orders/${sp.order}/issue`,T.owner,{kind:'out_of_stock',
  items:[{inventory_id:inv.desk46,quantity:1}],substitute:{inventory_id:inv.desk48,quantity:1}},randomUUID()));
 assert.equal((same.substitute_check as {unit_cents_delta: number}).unit_cents_delta,0);
 const sameDone=ok<CaseJson>(await call('POST',`/cases/${same.case_id}/respond`,T.agent,{expected_version:1,action:'accept'},randomUUID()));
 assert.equal(sameDone.status,'resolved');
 assert.equal((await order(sp.order)).refunded_cents,0,'a same-price substitute refunds nothing');
 // A 60in desk does not meet "max_width_in 48".
 const b=await paidOrder();
 const wide=ok<CaseJson>(await call('POST',`/seller/orders/${b.order}/issue`,T.owner,{kind:'out_of_stock',
  substitute:{replaces:inv.desk46,inventory_id:inv.desk60}}));
 assert.equal((wide.substitute_check as {meets_requirements: boolean}).meets_requirements,false);
 // Without a substitute: the seller proposes refunding the missing items.
 const c2=await paidOrder();
 const miss=ok<CaseJson>(await call('POST',`/seller/orders/${c2.order}/issue`,T.owner,{kind:'out_of_stock',items:[{inventory_id:inv.chair}]}));
 assert.deepEqual([miss.type,(miss.remedy as {kind: string; amount_cents: number}).kind,(miss.remedy as {amount_cents: number}).amount_cents],
  ['missing_item','refund_items',15000]);
 await drainRes();
});

test('chargebacks: evidence is assembled and submitted, or the dispute is accepted, once',async()=>{
 // Delivered order, "fraudulent": fight with the platform's evidence.
 const a=await paidOrder();
 ok(await call('POST',`/seller/orders/${a.order}/ship`,T.owner,{carrier:'UPS',tracking:'1ZDISPUTE'}));
 ok(await call('POST',`/seller/orders/${a.order}/simulate-delivery`,T.owner));
 const dispute={id:`dp_${randomUUID().slice(0,8)}`,object:'dispute',payment_intent:a.pi,amount:a.total,reason:'fraudulent',status:'needs_response'};
 const first=await stripeEvent('charge.dispute.created',dispute);
 assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.data?.decision,'fight');
 const call1=disputeCalls.find(c=>c.id===dispute.id);
 assert.equal(call1?.op,'update');assert.equal(call1?.params?.submit,true);
 const ev=call1!.params!.evidence!;
 assert.match(ev.uncategorized_text,/approved this purchase themselves/);
 assert.equal(ev.shipping_tracking_number,'1ZDISPUTE');assert.equal(ev.shipping_carrier,'UPS');
 assert.match(ev.product_description,/desk46 title/);
 assert.ok(!JSON.stringify(ev).includes('floor_cents')&&!JSON.stringify(ev).includes(buyerUser.email.toLowerCase()));
 const again=await stripeEvent('charge.dispute.created',dispute);
 assert.equal(again.body.data?.duplicate,true);
 assert.equal(disputeCalls.filter(c=>c.id===dispute.id).length,1,'decided once');
 const kinds=(await resEvents()).filter(e=>e.route.order_id===a.order&&e.kind.startsWith('dispute.')).map(e=>e.kind).sort();
 assert.deepEqual(kinds,['dispute.created','dispute.decided']);
 const closed=await stripeEvent('charge.dispute.closed',{...dispute,status:'won'});
 assert.equal(closed.body.data?.status,'won');

 // Not delivered and not about authorization: accept (close) the dispute.
 const b=await paidOrder();
 const lost={id:`dp_${randomUUID().slice(0,8)}`,object:'dispute',payment_intent:b.pi,amount:b.total,reason:'product_not_received',status:'needs_response'};
 assert.equal((await stripeEvent('charge.dispute.created',lost)).body.data?.decision,'accept');
 assert.equal(disputeCalls.find(c=>c.id===lost.id)?.op,'close');

 // An order paid before 0800 (no PaymentIntent stored) is found through its Checkout Session.
 const c=await paidOrder();
 await sql('UPDATE commerce_orders SET stripe_payment_intent=NULL WHERE id=$1',[c.order]);
 const old={id:`dp_${randomUUID().slice(0,8)}`,object:'dispute',payment_intent:c.pi,amount:c.total,reason:'general',status:'needs_response'};
 const found=await stripeEvent('charge.dispute.created',old);
 assert.equal(found.status,200,JSON.stringify(found.body));assert.equal(found.body.data?.order_id,c.order);
 assert.equal((await order(c.order)).stripe_payment_intent,c.pi);
 await drainRes();
});

test('email your agent and owner lookup: worker only, delegated requests of that exact email, no private fields',async()=>{
 const a=await paidOrder();
 await sql(`INSERT INTO commerce_requests(buyer_id,budget_cents,title,delegate_negotiation) VALUES($1,40000,'Kept for myself',false)`,[buyer]);
 await sql(`INSERT INTO commerce_requests(buyer_id,budget_cents,title,delegate_negotiation) VALUES($1,40000,'Someone else',true)`,[other]);
 err(await call('GET','/worker/buyer-requests?email=res.buyer@example.test',T.buyer),'forbidden',403);
 err(await call('GET','/worker/buyer-requests',T.worker),'invalid_input',400);
 const list=ok<{request_id: string; title: string; order?: {status: string}; watch_path: string}[]>(
  await call('GET','/worker/buyer-requests?email=RES.BUYER@example.test',T.worker));
 assert.ok(list.some(r=>r.request_id===a.request&&r.order?.status&&r.watch_path===`/watch/${a.request}`));
 assert.ok(!list.some(r=>r.title==='Kept for myself'||r.title==='Someone else'));
 assert.ok(!/budget|target|floor|email/.test(JSON.stringify(list)));
 assert.deepEqual(ok<unknown[]>(await call('GET','/worker/buyer-requests?email=nobody@example.test',T.worker)),[]);
 const owner=ok(await call('GET',`/worker/sellers/${seller}/owner`,T.worker));
 assert.deepEqual([owner.seller_id,owner.owner_email],[seller,ownerUser.email]);
 err(await call('GET',`/worker/sellers/${seller}/owner`,T.owner),'forbidden',403);
 err(await call('GET',`/worker/sellers/${randomUUID()}/owner`,T.worker),'seller_not_found',404);
});

test('policy: owner reads and changes it, agents cannot, values are validated',async()=>{
 const p=ok(await call('GET','/seller/policy',T.sellerAgent));
 assert.equal(p.max_auto_partial_refund_pct,15);
 err(await call('PUT','/seller/policy',T.sellerAgent,{max_auto_partial_refund_pct:50}),'forbidden',403);
 err(await call('PUT','/seller/policy',T.owner,{max_auto_partial_refund_pct:500}),'invalid_input',400);
 err(await call('PUT','/seller/policy',T.owner,{surprise:1}),'invalid_input',400);
 err(await call('PUT','/seller/policy',T.owner,{return_window_days:1.5}),'invalid_input',400);
 const set=ok(await call('PUT','/seller/policy',T.owner,{max_auto_partial_refund_pct:20,seller_pays_return_shipping_when_at_fault:false}));
 assert.deepEqual([set.max_auto_partial_refund_pct,set.seller_pays_return_shipping_when_at_fault,set.return_window_days],[20,false,14]);
 ok(await call('PUT','/seller/policy',T.owner,{max_auto_partial_refund_pct:15,seller_pays_return_shipping_when_at_fault:true}));
 const sweep=ok(await call('POST','/worker/resolution-sweep',T.worker));
 assert.equal(typeof sweep.orders_closed,'number');
});

test('web dashboard routes: buyers and owners act only on their own orders, cases and businesses',async()=>{
 const a=await paidOrder();
 const mine=ok<{order_id: string}[]>(await call('GET','/orders',BUYER_SESSION));
 assert.ok(mine.some(o=>o.order_id===a.order));
 assert.ok(!ok<{order_id: string}[]>(await call('GET','/orders',OTHER_SESSION)).some(o=>o.order_id===a.order));
 err(await call('GET',`/orders/${a.order}`,OTHER_SESSION),'forbidden',403);
 err(await call('POST',`/orders/${a.order}/cases`,OTHER_SESSION,{type:'damaged'}),'forbidden',403);
 ok(await call('GET',`/orders/${a.order}`,BUYER_SESSION));
 // An owner manages orders through their own business only.
 err(await call('GET',`/businesses/${seller}/orders`,OTHER_SESSION),'forbidden',403);
 err(await call('POST',`/businesses/${otherSeller}/orders/${a.order}/ship`,OTHER_SESSION,{carrier:'UPS',tracking:'X'}),'forbidden',403);
 ok(await call('POST',`/businesses/${seller}/orders/${a.order}/ship`,OWNER_SESSION,{carrier:'UPS',tracking:'1ZWEB'}));
 ok(await call('POST',`/businesses/${seller}/orders/${a.order}/simulate-delivery`,OWNER_SESSION));
 const c=ok<CaseJson>(await call('POST',`/orders/${a.order}/cases`,BUYER_SESSION,{type:'damaged',
  requested_remedy:{kind:'refund_partial',amount_cents:20000}},randomUUID()));
 err(await call('GET',`/cases/${c.case_id}`,OTHER_SESSION),'forbidden',403);
 err(await call('POST',`/businesses/${otherSeller}/cases/${c.case_id}/respond`,OTHER_SESSION,{expected_version:1,action:'accept'}),'forbidden',403);
 assert.ok(ok<{case_id: string}[]>(await call('GET',`/businesses/${seller}/cases`,OWNER_SESSION)).some(x=>x.case_id===c.case_id));
 const withPhoto=ok<{evidence: {kind: string; by: string}[]}>(await call('POST',`/cases/${c.case_id}/evidence`,BUYER_SESSION,
  {kind:'photo',ref:'https://img.test/dent.jpg'},randomUUID()));
 assert.deepEqual(withPhoto.evidence.map(e=>[e.kind,e.by]),[['photo','buyer']]);
 const countered=ok<CaseJson>(await call('POST',`/businesses/${seller}/cases/${c.case_id}/respond`,OWNER_SESSION,
  {expected_version:1,action:'counter',remedy:{kind:'keep_with_discount',amount_cents:6000}},randomUUID()));
 assert.equal(countered.turn,'buyer');
 const accepted=ok<CaseJson>(await call('POST',`/cases/${c.case_id}/respond`,BUYER_SESSION,{expected_version:2,action:'accept'},randomUUID()));
 assert.equal(accepted.resolution?.amount_cents,6000);
 err(await call('POST',`/cases/${c.case_id}/evidence`,BUYER_SESSION,{kind:'text',ref:'Too late.'},randomUUID()),'case_closed',409);
 const pol=ok(await call('GET',`/businesses/${seller}/policy`,OWNER_SESSION));
 assert.equal(pol.return_window_days,14);
 err(await call('PUT',`/businesses/${seller}/policy`,OTHER_SESSION,{return_window_days:30}),'forbidden',403);
 // Existing user-session routes are untouched.
 ok(await call('GET','/buy-requests',BUYER_SESSION));
 await drainRes();
});
