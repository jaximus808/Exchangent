'use client';
import {useEffect,useRef,useState} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {ArrowRight,Check,CheckCircle2,PackageCheck,RefreshCw,ShieldCheck,ShoppingBag,Store} from 'lucide-react';
import type {Conversation} from '@/lib/conversation';
import {verifiedPurchase,type StockMove} from '@/lib/purchase-finish';
import {api,money,type OrderStatus} from '@/lib/workspace';
import {orderLink} from '@/lib/watch-view';
import './purchase-finish.css';

export function PurchaseFinish({conversation,onReceipt}:{conversation:Conversation;onReceipt?:(receipt:OrderStatus|null)=>void}) {
 const[receipt,setReceipt]=useState<OrderStatus|null>(null),[error,setError]=useState(false),[attempt,setAttempt]=useState(0);
 const firstStatus=useRef(conversation.status),reduced=useReducedMotion();
 const id=conversation.reservation?.reservation_id,ready=conversation.status==='confirmed'&&conversation.reservation?.status==='consumed';
 useEffect(()=>{
  setReceipt(null);setError(false);if(!ready||!id)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const load=async()=>{if(document.visibilityState==='hidden'){timer=setTimeout(()=>void load(),5000);return;}try{const row=await api<OrderStatus>(`reservations/${id}`,{signal:controller.signal});if(controller.signal.aborted)return;setReceipt(row);setError(row.status==='consumed'&&row.order?.status==='confirmed'&&!verifiedPurchase(conversation,row));if(row.status!=='consumed'||row.order?.status!=='confirmed')timer=setTimeout(()=>void load(),4000);}catch{if(!controller.signal.aborted){setError(true);timer=setTimeout(()=>void load(),8000);}}};
  void load();return()=>{controller.abort();if(timer)clearTimeout(timer);};
 },[id,conversation.request_id,ready,attempt]);
 useEffect(()=>{onReceipt?.(receipt);},[receipt,onReceipt]);
 if(!ready)return null;
 if(receipt?.order&&['refunded','cancelled'].includes(receipt.order.status))return <section className="finish-verifying" role="status"><ShieldCheck size={19}/><span>{receipt.order.status==='refunded'?'Order refunded':'Order cancelled'}<small>See Orders for current case and payment details.</small></span><a href={orderLink(conversation.request_id)}>View order<ArrowRight size={13}/></a></section>;
 const purchase=verifiedPurchase(conversation,receipt);
 if(!purchase)return <section className="finish-verifying" role="status"><ShieldCheck size={19}/><span>{error?'Receipt temporarily unavailable':'Checking your order receipt'}<small>Payment status stays in your saved order.</small></span>{error&&<button onClick={()=>setAttempt(n=>n+1)}><RefreshCw size={13}/>Retry</button>}</section>;
 const fresh=firstStatus.current!=='confirmed';
 return <motion.section className={`purchase-finish ${fresh?'fresh':''}`} initial={fresh&&!reduced?{opacity:.45,y:8}:false} animate={{opacity:1,y:0}} transition={{duration:.55,ease:[.2,.7,.2,1]}} aria-label="Completed purchase" role="status">
  <header><span><CheckCircle2 size={19}/><h2>Deal complete.</h2></span><span><ShieldCheck size={13}/>Payment verified · Test mode</span></header>
  <div className="finish-bridge"><div className="finish-side buyer"><span className="finish-side-icon"><ShoppingBag size={21}/></span><div><small>Your order</small><strong>{money(purchase.total)}</strong><span>#{purchase.order.id.slice(0,8).toUpperCase()}</span></div><Check size={15} className="finish-check"/></div>
   <div className="finish-flow" aria-hidden="true"><span/><svg width="48" height="46" viewBox="0 0 48 46" fill="none"><path d="m24 3 20 11-20 11L4 14 24 3Z" fill="#f4f8f4" stroke="#89a693"/><path d="M4 14v20l20 11V25L4 14Z" fill="#dce9df" stroke="#89a693"/><path d="M44 14v20L24 45V25l20-11Z" fill="#c6dacb" stroke="#89a693"/><path d="m14 8 20 11v10" stroke="#89a693"/></svg><span/></div>
   <div className="finish-side seller"><span className="finish-side-icon"><Store size={21}/></span><div><small>{purchase.seller.name}</small><strong>{purchase.quantity} {purchase.quantity===1?'item':'items'} sold</strong><span>Inventory committed</span></div><PackageCheck size={19} className="finish-check"/></div></div>
  <footer><details><summary>{purchase.items.length===1?purchase.items[0].title:`${purchase.items.length} order lines`}</summary><ul>{purchase.items.map((item,i)=><li key={i}><span>{item.quantity}× {item.title}</span><b>{money(item.quantity*item.unit_cents)}</b></li>)}{receipt!.delivery_cents!>0&&<li><span>Delivery</span><b>{money(receipt!.delivery_cents!)}</b></li>}{receipt!.tax_cents!>0&&<li><span>Tax</span><b>{money(receipt!.tax_cents!)}</b></li>}<li className="finish-line-total"><span>Total paid</span><b>{money(purchase.total)}</b></li></ul></details><a href={orderLink(conversation.request_id)}>View receipt<ArrowRight size={13}/></a></footer>
 </motion.section>;
}

export function SellerStockMoves({moves}:{moves:StockMove[]}) {
 if(!moves.length)return null;
 return <section className="seller-stock-moves" aria-label="Latest inventory changes"><header><PackageCheck size={15}/><strong>Stock updated</strong><small>Last observed change</small></header>{moves.slice(0,3).map(move=><div key={`${move.id}-${move.available}-${move.sold}`} className="seller-stock-move"><span>{move.title}</span><dl><div><dt>Available</dt><dd><del>{move.beforeAvailable}</del><ArrowRight size={12}/><b>{move.available}</b></dd></div><div className={move.sold!==null&&move.beforeSold!==null&&move.sold>move.beforeSold?'sold':''}><dt>Sold</dt><dd><del>{move.beforeSold??'—'}</del><ArrowRight size={12}/><b>{move.sold??'—'}</b></dd></div></dl></div>)}{moves.length>3&&<small>+{moves.length-3} more changes in inventory</small>}</section>;
}
