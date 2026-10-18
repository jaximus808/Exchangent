// Order confirmation email through Primitive (https://docs.primitive.dev/docs/sending).
// Runs after the Stripe webhook confirms an order. It never throws: a failed send is logged
// and the order.confirmed outbox row stays pending, so a later webhook retry can send it.
// Exactly-once: the outbox row's delivered_at is checked first and set after the send, and
// every send carries a per-order Idempotency-Key, which Primitive keeps with no expiry. If
// the send succeeded but the ack did not, the retried send is replayed by Primitive and
// does not deliver a second copy.
import type { ReceiptItem, ReservationStatusView } from './commerce.ts';
import type { RpcDb } from './types.ts';

export const PRIMITIVE_API_URL='https://api.primitive.dev/v1';
/** commerce_order_email (migrations/20261018000300_order-email.sql). */
export interface OrderEmailTarget {
 order_id: string; reservation_id: string; buyer_id: string; email: string | null; delivered: boolean;
}
export type OrderEmailOutcome='sent' | 'already_sent' | 'no_recipient' | 'failed';
/** Loads the buyer's receipt: the same view as GET /api/v1/reservations/:id. */
export type ReceiptLoader=(reservationId: string, buyerId: string)=>Promise<ReservationStatusView>;
export interface OrderEmailOptions {
 db: RpcDb; apiKey: string; from: string;
 fetch?: typeof fetch; apiUrl?: string; timeoutMs?: number; log?: (line: string)=>void;
}
export interface RenderedEmail { subject: string; text: string; html: string }

class SendError extends Error {}
const money=(cents: number,currency: string)=>
 new Intl.NumberFormat('en-US',{style:'currency',currency:currency.toUpperCase()}).format(cents/100);
// Seller and item names come from sellers: one line, no control characters, HTML-escaped in HTML.
const plain=(s: string)=>s.replace(/[\u0000-\u001f\u007f]+/g,' ').trim();
const html=(s: string)=>plain(s).replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);

/** Deterministic for one order, so a retried send matches Primitive's stored payload. */
export function renderOrderEmail(orderId: string,r: ReservationStatusView): RenderedEmail {
 const $=(cents: number)=>money(cents,r.currency),seller=plain(r.seller.name);
 const line=(i: ReceiptItem)=>`${i.quantity} × ${plain(i.title)}: ${$(i.quantity*i.unit_cents)}`;
 const totals: [string,number][]=[['Subtotal',r.subtotal_cents],['Delivery',r.delivery_cents],['Tax',r.tax_cents]];
 const subject=`Order confirmed: ${seller}, ${$(r.total_cents)}`;
 const text=['Your Exchangent order is confirmed.','',`Seller: ${seller}`,`Order: ${orderId}`,'',
  ...r.items.map(line),'',...totals.map(([k,v])=>`${k}: ${$(v)}`),`Total paid: ${$(r.total_cents)}`,'',
  'Stripe test mode: no real money was charged.',''].join('\n');
 const row=(k: string,v: string,strong=false)=>
  `<tr><td style="padding:4px 16px 4px 0">${strong?`<strong>${k}</strong>`:k}</td><td style="padding:4px 0;text-align:right">${strong?`<strong>${v}</strong>`:v}</td></tr>`;
 const body=`<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f7f8f5;color:#252823;font:16px/1.6 system-ui,sans-serif">
<div style="max-width:480px;margin:0 auto;padding:32px;border:1px solid #e3e6df;border-radius:12px;background:#fff">
<p style="margin:0;font-size:20px;font-weight:600">⇄ exchangent.</p>
<h1 style="font-size:24px;line-height:1.2;margin:24px 0 8px">Your order is confirmed.</h1>
<p style="margin:0 0 20px;color:#62685f">Seller: ${html(r.seller.name)}<br>Order: ${html(orderId)}</p>
<table style="width:100%;border-collapse:collapse">
${r.items.map(i=>row(`${i.quantity} × ${html(i.title)}`,$(i.quantity*i.unit_cents))).join('\n')}
${totals.map(([k,v])=>row(k,$(v))).join('\n')}
${row('Total paid',$(r.total_cents),true)}
</table>
<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e3e6df;color:#62685f;font-size:14px">Stripe test mode: no real money was charged.</p>
</div></body></html>`;
 return {subject,text,html:body};
}

export class OrderEmail {
 db: RpcDb; apiKey: string; from: string; fetch: typeof fetch; apiUrl: string; timeoutMs: number; log: (line: string)=>void;
 constructor({db,apiKey,from,fetch: fetchImpl=globalThis.fetch,apiUrl=PRIMITIVE_API_URL,timeoutMs=8000,
  log=line=>console.error(line)}: OrderEmailOptions) {
  this.db=db;this.apiKey=apiKey;this.from=from;this.fetch=fetchImpl;this.apiUrl=apiUrl;this.timeoutMs=timeoutMs;this.log=log;
 }
 async rpc<T>(name: string,args: Record<string, unknown>): Promise<T> {
  const {data,error}=await this.db.database.rpc(name,args);
  if(error) throw new SendError(/^[a-z_]+$/.test(error.message)?error.message:'database_error');
  return data as T; // jsonb built by our own SQL function
 }
 /** Sends the confirmation for one order at most once. Never throws. */
 async deliver(orderId: string,receipt: ReceiptLoader): Promise<OrderEmailOutcome> {
  try {
   const target=await this.rpc<OrderEmailTarget>('commerce_order_email',{p_order:orderId});
   if(target.delivered) return 'already_sent';
   // Left pending: nobody to send to (demo buyer without an InsForge account).
   if(!target.email) {this.log(`order_email skipped order=${orderId} reason=no_recipient`);return 'no_recipient';}
   const view=await receipt(target.reservation_id,target.buyer_id);
   if(view.order&&view.order.id!==orderId) throw new SendError('order_mismatch');
   await this.send(orderId,target.email,renderOrderEmail(orderId,view));
   await this.rpc('commerce_ack_order_email',{p_order:orderId});
   return 'sent';
  } catch(error) {
   // Codes only: never the address, the API key or a provider message body.
   const reason=error instanceof SendError?error.message:(error as {code?: unknown})?.code??(error as Error)?.name??'error';
   this.log(`order_email failed order=${orderId} reason=${String(reason).replace(/[^\w.-]/g,'_').slice(0,80)}`);
   return 'failed';
  }
 }
 async send(orderId: string,to: string,{subject,text,html: bodyHtml}: RenderedEmail) {
  const res=await this.fetch(`${this.apiUrl}/send-mail`,{method:'POST',signal:AbortSignal.timeout(this.timeoutMs),
   headers:{authorization:`Bearer ${this.apiKey}`,'content-type':'application/json',
    'idempotency-key':`exchangent-order-confirmed-${orderId}`},
   body:JSON.stringify({from:this.from,to,subject,body_text:text,body_html:bodyHtml,
    headers:{'Auto-Submitted':'auto-generated'},
    tags:[{name:'category',value:'order_confirmation'},{name:'order_id',value:orderId}]})});
  // Primitive envelope: {success:true,data} or {success:false,error:{code,message}}.
  const payload=await res.json().catch(()=>null) as {success?: boolean; error?: {code?: unknown}} | null;
  if(!res.ok||payload?.success===false) {
   const code=typeof payload?.error?.code==='string'?payload.error.code:'error';
   throw new SendError(`primitive_${res.status}_${code}`);
  }
 }
}

/** Disabled (undefined) unless both PRIMITIVE_API_KEY and PRIMITIVE_FROM are set. */
export function orderEmailFromEnv(db: RpcDb,env: NodeJS.ProcessEnv=process.env): OrderEmail | undefined {
 const apiKey=env.PRIMITIVE_API_KEY?.trim(),from=env.PRIMITIVE_FROM?.trim();
 if(apiKey&&from) return new OrderEmail({db,apiKey,from});
 if(apiKey||from) console.error('order_email disabled: set both PRIMITIVE_API_KEY and PRIMITIVE_FROM');
 return undefined;
}
