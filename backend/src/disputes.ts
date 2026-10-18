// Stripe charge events after payment (doc/resolution-contract.md): bank disputes (chargebacks) and refunds
// made in Stripe. On charge.dispute.created the platform answers by itself: it assembles the evidence it holds
// (the agreed items and transcript, the buyer's own payment approval, shipping and delivery, cases and refunds)
// and decides to fight or accept by the seller's policy. Imports nothing at runtime from commerce.ts, which
// imports this module.
import type Stripe from 'stripe';
import type { Commerce } from './commerce.ts';

const DISPUTE_EVENTS=new Set(['charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.refunded']);
export const isChargeEvent=(event: Stripe.Event)=>DISPUTE_EVENTS.has(event.type);

interface DisputeRow { dispute_id: string; order_id: string; stripe_dispute_id: string; reason: string | null; amount_cents: number;
 status: string; decision: 'fight' | 'accept' | null; created: boolean }
interface Message { kind: string; by: string; total_cents?: number; note?: string; reason?: string; at: string }
interface Evidence {
 order: { title: string | null; seller_name: string; total_cents: number; refunded_cents: number; created_at: string;
  shipped_at: string | null; delivered_at: string | null; carrier: string | null; tracking: string | null;
  delivery_evidence: { source: string; at: string } | null; refunds: { amount_cents: number; status: string; created_at: string }[] };
 agreement: { offer_id: string; items: { title: string; category: string | null; attributes: Record<string,unknown>; quantity: number; unit_cents: number }[];
  transcript: Message[] | null };
 approval: { reserved_at: string; checkout_session: string; paid_at: string; statement: string };
 cases: { type: string; status: string; resolution: Record<string,unknown> | null }[];
 policy: { return_window_days: number; restocking_fee_pct: number; fight_chargebacks_above_cents: number };
}

const usd=(cents: number)=>`$${(cents/100).toFixed(2)}`;
const day=(iso: string | null)=>iso?iso.slice(0,10):undefined;
const clip=(s: string,max=19000)=>s.length>max?`${s.slice(0,max-1)}…`:s;
const piOf=(x: string | {id: string} | null | undefined)=>typeof x==='string'?x:x?.id??null;

/** Fight when the platform holds strong evidence and the amount is worth it; a refunded order always answers. */
export function decide(e: Evidence,dispute: {reason: string | null; amount_cents: number}): 'fight' | 'accept' {
 if(e.order.refunded_cents>0&&e.order.refunded_cents>=dispute.amount_cents) return 'fight'; // never refund twice
 const delivered=!!e.order.delivered_at;
 const authorized=['fraudulent','unrecognized'].includes(dispute.reason??'');
 return (delivered||authorized)&&dispute.amount_cents>=e.policy.fight_chargebacks_above_cents?'fight':'accept';
}

/** Stripe dispute evidence (text fields only; file fields need uploads). */
export function evidenceFields(e: Evidence): Stripe.DisputeUpdateParams.Evidence {
 const items=e.agreement.items.map(i=>`${i.title} (${[i.category,...Object.entries(i.attributes??{}).map(([k,v])=>`${k}: ${String(v)}`)]
  .filter(Boolean).join('; ')}) x${i.quantity} at ${usd(i.unit_cents)}`).join('\n');
 const transcript=(e.agreement.transcript??[]).map(m=>`${m.at} ${m.by} ${m.kind}${m.total_cents!==undefined?` ${usd(m.total_cents)}`:''}`+
  `${m.note?`: ${m.note}`:''}${m.reason?` (${m.reason})`:''}`).join('\n');
 const refunds=e.order.refunds.filter(r=>r.status!=='failed');
 const lines=[
  e.approval.statement,
  `Reserved at ${e.approval.reserved_at}; paid at ${e.approval.paid_at} through Stripe Checkout session ${e.approval.checkout_session}.`,
  `Order: ${e.order.title??'Order'} from ${e.order.seller_name}, ${usd(e.order.total_cents)}.`,
  e.order.delivered_at?`Delivered ${e.order.delivered_at} (${e.order.delivery_evidence?.source??'recorded'}).`:'Delivery not recorded.',
  refunds.length?`Refunds: ${refunds.map(r=>`${usd(r.amount_cents)} (${r.status}, ${r.created_at})`).join(', ')}.`:'No refunds.',
  e.cases.length?`Cases: ${e.cases.map(c=>`${c.type} ${c.status}${c.resolution?.kind?` -> ${String(c.resolution.kind)}`:''}`).join('; ')}.`:'The buyer opened no case with the seller.',
 ];
 return {
  product_description:clip(`${items}\nSold by ${e.order.seller_name} via Exchangent.`),
  uncategorized_text:clip(lines.join('\n')),
  access_activity_log:clip(`Negotiation transcript (agreed through Exchangent):\n${transcript}`),
  refund_policy_disclosure:clip(`Returns accepted within ${e.policy.return_window_days} days of delivery; restocking fee ${e.policy.restocking_fee_pct}%. `+
   'Problems are resolved in the Exchangent resolution center (refund, replacement, return or discount).'),
  ...(e.order.carrier?{shipping_carrier:e.order.carrier}:{}),
  ...(e.order.tracking?{shipping_tracking_number:e.order.tracking}:{}),
  ...(day(e.order.shipped_at)?{shipping_date:day(e.order.shipped_at)}:{}),
  ...(!refunds.length&&e.order.delivered_at?{refund_refusal_explanation:clip('The goods were delivered as agreed and the buyer did not '+
   'request a refund through the resolution center.')}:{}),
 };
}

async function rpc<T>(commerce: Commerce,name: string,args: Record<string,unknown>) { return commerce.rpc<T>(name,args); }

/** Find the order for a dispute. Orders paid before migration 0800 have no PaymentIntent stored: look it up. */
async function recordDispute(commerce: Commerce,d: Stripe.Dispute): Promise<DisputeRow> {
 const args={p_stripe_dispute:d.id,p_payment_intent:piOf(d.payment_intent),p_reason:d.reason??null,p_amount:d.amount,p_status:d.status};
 try {return await rpc<DisputeRow>(commerce,'commerce_record_dispute',args);}
 catch(error) {
  if((error as {code?: string}).code!=='order_not_found'||!args.p_payment_intent) throw error;
  const sessions=await commerce.stripe.checkout.sessions.list({payment_intent:args.p_payment_intent,limit:1});
  const sessionId=sessions.data[0]?.id;
  if(!sessionId) throw error;
  const {data}=await commerce.db.database.from('commerce_orders').select('id').eq('stripe_session_id',sessionId).limit(1);
  const order=(data?.[0] as {id?: string} | undefined)?.id;
  if(!order) throw error;
  await rpc(commerce,'commerce_set_payment_intent',{p_order:order,p_payment_intent:args.p_payment_intent});
  return rpc<DisputeRow>(commerce,'commerce_record_dispute',args);
 }
}

/**
 * Handles charge.* events; returns undefined for any other event. A failed Stripe call throws, so Stripe
 * retries the event and the decision is made again (record_dispute is idempotent; a decision is made once).
 */
export async function chargeEvent(commerce: Commerce,event: Stripe.Event): Promise<Record<string,unknown> | undefined> {
 if(!isChargeEvent(event)) return undefined;
 if(event.type==='charge.refunded') {
  const charge=event.data.object as Stripe.Charge;
  const pi=piOf(charge.payment_intent);
  if(!pi) return {ignored:true};
  return {reconciled:await rpc<number>(commerce,'commerce_reconcile_refunds',{p_payment_intent:pi,p_amount_refunded:charge.amount_refunded})};
 }
 const d=event.data.object as Stripe.Dispute;
 if(event.type!=='charge.dispute.created') {
  return (await rpc<Record<string,unknown> | null>(commerce,'commerce_dispute_status',{p_stripe_dispute:d.id,p_status:d.status}))??{ignored:true};
 }
 const row=await recordDispute(commerce,d);
 if(row.decision) return {...row,duplicate:true};
 const evidence=await rpc<Evidence>(commerce,'commerce_dispute_evidence',{p_order:row.order_id});
 const decision=decide(evidence,row);
 let status=d.status;
 if(decision==='fight') {
  const fields=evidenceFields(evidence);
  status=(await commerce.stripe.disputes.update(d.id,{evidence:fields,submit:true})).status;
  return rpc(commerce,'commerce_dispute_decided',{p_dispute:row.dispute_id,p_decision:'fight',p_evidence:fields,p_submitted:true,p_status:status});
 }
 status=(await commerce.stripe.disputes.close(d.id)).status;
 return rpc(commerce,'commerce_dispute_decided',{p_dispute:row.dispute_id,p_decision:'accept',p_evidence:null,p_submitted:false,p_status:status});
}
