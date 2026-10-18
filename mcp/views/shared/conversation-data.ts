import {z} from 'zod';

// get_conversation result (backend commerce_conversation). Never carries floors, budgets or line items.
const cents=z.number().int().nonnegative();
const delivery=z.looseObject({transport:z.string().optional(),from_handle:z.string().optional(),to_handle:z.string().optional(),message_id:z.string().optional(),context_id:z.string().optional(),delivered_at:z.string().optional()});
const message=z.looseObject({kind:z.string(),by:z.string(),total_cents:cents.optional(),note:z.string().nullable().optional(),reason:z.string().nullable().optional(),version:z.number().optional(),at:z.string().optional(),delivery:delivery.nullable().optional()});
const session=z.looseObject({session_id:z.string(),seller_name:z.string().optional(),status:z.string().optional(),turn:z.string().optional(),rounds:z.number().optional(),decline_reason:z.string().nullable().optional(),close_reason:z.string().nullable().optional(),seller_agent:z.boolean().optional(),seller_handle:z.string().nullable().optional(),messages:z.array(message).optional()});
const conversationSchema=z.looseObject({status:z.enum(['ok','error']),request_id:z.string().optional(),title:z.string().nullable().optional(),request_status:z.string().optional(),delegate_negotiation:z.boolean().optional(),watch_url:z.string().optional(),sessions:z.array(session).optional(),error:z.looseObject({code:z.string()}).optional(),next:z.string().optional()});
export type Conversation=z.infer<typeof conversationSchema>;
export type Thread=z.infer<typeof session>;
export type Message=z.infer<typeof message>;

export function readConversation(value:unknown):Conversation {
 const parsed=conversationSchema.safeParse(value);
 if(!parsed.success)throw Error('The conversation could not be displayed. Ask your assistant to refresh it.');
 return parsed.data;
}
/** Latest offer per open thread, lowest first: the best deal on the table right now. */
export function bestOffer(data:Conversation):{seller:string;total:number}|null {
 let best:{seller:string;total:number}|null=null;
 for(const s of data.sessions??[]) {
  if(s.status!=='open')continue;
  const last=[...(s.messages??[])].reverse().find(m=>m.kind==='offer'&&m.total_cents!==undefined);
  if(last&&(!best||last.total_cents!<best.total))best={seller:s.seller_name??'Seller',total:last.total_cents!};
 }
 return best;
}
export function speaker(m:Message,s:Thread,delegated:boolean|undefined):string {
 const seller=s.seller_name??'Seller';
 if(m.by==='buyer')return delegated===false?'You':'Your agent';
 if(m.by==='seller')return s.seller_agent===false?seller:`${seller} agent`;
 return 'Exchangent';
}
/** "Inkbox A2A · exchangent-a → exchangent-b · 1a2b3c4d" — the hop that announced this turn. */
export function hopLine(m:Message):string {
 const d=m.delivery;
 if(!d)return m.kind==='opened'?'':'Delivery pending';
 const route=d.from_handle||d.to_handle?` · ${d.from_handle??'?'} → ${d.to_handle??'?'}`:'';
 const id=d.message_id?` · ${d.message_id.slice(0,8)}`:'';
 return `${d.transport==='inkbox'?'Inkbox A2A':'Delivered in-process'}${route}${id}`;
}
