// Unit checks for the chargeback decision and evidence text (src/disputes.ts) and the web dashboard
// route matcher (src/resolution.ts). The SQL side is covered by test/sql/resolution.db.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, evidenceFields } from '../src/disputes.ts';
import { Resolution, testMode, userResolutionRoute } from '../src/resolution.ts';

const evidence=(over: Record<string,unknown>={})=>({
 order:{title:'Desk and chair',seller_name:'Alex Woodworks',total_cents:30000,refunded_cents:0,created_at:'2026-10-18T04:50:00Z',
  shipped_at:'2026-10-18T06:00:00Z',delivered_at:'2026-10-19T12:00:00Z',carrier:'UPS',tracking:'1Z999',
  delivery_evidence:{source:'carrier',at:'2026-10-19T12:00:00Z'},refunds:[],...over},
 agreement:{offer_id:'o1',items:[{title:'Walnut desk',category:'desk',attributes:{width_in:46},quantity:1,unit_cents:15500}],
  transcript:[{kind:'offer',by:'seller',total_cents:46500,note:'Opening',at:'2026-10-18T04:44:00Z'},{kind:'counter',by:'buyer',total_cents:30000,at:'2026-10-18T04:45:00Z'}]},
 approval:{reserved_at:'2026-10-18T04:49:00Z',checkout_session:'cs_test_1',paid_at:'2026-10-18T04:50:00Z',statement:'The buyer approved this purchase themselves.'},
 cases:[],policy:{return_window_days:14,restocking_fee_pct:0,fight_chargebacks_above_cents:5000},
});

test('dispute decision: fight with delivery or an authorization claim above the threshold; refunded orders always answer',()=>{
 assert.equal(decide(evidence(),{reason:'product_not_received',amount_cents:30000}),'fight');
 assert.equal(decide(evidence({delivered_at:null}),{reason:'product_not_received',amount_cents:30000}),'accept');
 assert.equal(decide(evidence({delivered_at:null}),{reason:'fraudulent',amount_cents:30000}),'fight');
 assert.equal(decide(evidence(),{reason:'fraudulent',amount_cents:4000}),'accept','below the policy threshold');
 assert.equal(decide(evidence({delivered_at:null,refunded_cents:30000}),{reason:'general',amount_cents:30000}),'fight','never refund twice');
});

test('dispute evidence: text fields only, transcript and approval included, nothing private',()=>{
 const f=evidenceFields(evidence() as Parameters<typeof evidenceFields>[0]);
 assert.match(f.product_description!,/Walnut desk \(desk; width_in: 46\) x1 at \$155\.00/);
 assert.match(f.access_activity_log!,/seller offer \$465\.00: Opening/);
 assert.match(f.uncategorized_text!,/approved this purchase themselves/);
 assert.equal(f.shipping_tracking_number,'1Z999');assert.equal(f.shipping_date,'2026-10-18');
 assert.ok(f.refund_refusal_explanation);
 assert.ok(!('customer_communication' in f)&&!('refund_policy' in f),'file fields are never sent as text');
 const refunded=evidenceFields(evidence({refunds:[{amount_cents:30000,status:'succeeded',created_at:'2026-10-20T00:00:00Z'}]}) as Parameters<typeof evidenceFields>[0]);
 assert.ok(!refunded.refund_refusal_explanation);assert.match(refunded.uncategorized_text!,/Refunds: \$300\.00/);
});

test('web dashboard routes: unknown paths fall through without requiring a user session',async()=>{
 let asked=0;
 const r=new Proxy({},{get:(_t,k)=>()=>`called ${String(k)}`}) as unknown as Resolution;
 const route=(method: string,path: string)=>userResolutionRoute(r,{actor:()=>{asked++;return 'actor';},method,path,key:undefined,
  input:async()=>({}),ownBusiness:async()=>undefined});
 assert.equal(await route('GET','/api/v1/buy-requests'),undefined);
 assert.equal(await route('GET','/api/v1/businesses/x/sessions'),undefined);
 assert.equal(await route('POST','/api/v1/orders/x'),undefined);
 assert.equal(asked,0,'no session check for paths that are not ours');
 assert.equal(await route('GET','/api/v1/orders'),'called userOrders');
 assert.equal(await route('POST','/api/v1/businesses/s/orders/o/ship'),'called ship');
 assert.equal(await route('PUT','/api/v1/businesses/s/policy'),'called setPolicy');
 assert.equal(await route('POST','/api/v1/businesses/s/cases/c/return-received'),'called returnReceived');
});

test('simulated deliveries only in Stripe test mode',()=>{
 assert.equal(testMode({}),true);assert.equal(testMode({STRIPE_SECRET_KEY:'sk_test_x'}),true);
 assert.equal(testMode({STRIPE_SECRET_KEY:'sk_live_x'}),false);
});
