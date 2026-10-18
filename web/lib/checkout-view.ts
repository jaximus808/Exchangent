import type {Conversation} from './conversation.ts';
import type {OrderStatus} from './workspace.ts';
const active=new Set(['held','checkout_open','payment_pending','consumed']);
/** Only saved state belonging to this request may drive a checkout action. */
export function savedReservationId(requestId:string,conversation?:Conversation|null,receipt?:OrderStatus|null) {
 if(conversation?.request_id===requestId&&conversation.reservation&&active.has(conversation.reservation.status))return conversation.reservation.reservation_id;
 if(receipt?.request_id===requestId&&active.has(receipt.status))return receipt.reservation_id;
 return null;
}
export function checkoutState(requestStatus:string,receipt:OrderStatus|null,conversation?:Conversation|null) {
 if(receipt?.order&&['refunded','cancelled'].includes(receipt.order.status))return 'reversed';
 if(receipt?.status==='consumed'&&receipt.order?.status==='confirmed')return 'confirmed';
 if(receipt?.status==='payment_pending'||conversation?.reservation?.status==='payment_pending'||receipt?.status==='consumed'||requestStatus==='confirmed')return 'verifying';
 if(receipt&&['expired','released','failed','cancelled'].includes(receipt.status))return 'ended';
 return 'approval';
}
