'use client';
import {useActionState,useEffect,useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {Check,Loader2,ShoppingBag,Store} from 'lucide-react';
import type {AuthorizeParams} from '@/lib/oauth';
import {decideConsent,signOutForConsent,type ConsentState} from './actions';

type Choice={value:string;title:string;subtitle:string;kind:'buyer'|'seller'};

const allows={
 buyer:['Create buy requests for you','See offers from businesses','Counter offers and reserve items','Get checkout links. It never pays — you approve every payment.'],
 seller:['See buy requests from shoppers','Make offers within your price floors','Decline requests'],
};

/** Consent. Only non-secret OAuth parameters reach the client; the server action re-validates all of them. */
export function ConsentForm({params,email,businesses}:{params:AuthorizeParams;email:string;businesses:{seller_id:string;name:string}[]}) {
 const router=useRouter();
 const[state,action,pending]=useActionState<ConsentState,FormData>(decideConsent,{});
 const[clicked,setClicked]=useState<'approve'|'deny'|null>(null);
 const choices:Choice[]=[
  {value:'buyer',title:'Buyer account',subtitle:email,kind:'buyer'},
  ...businesses.map(b=>({value:`seller:${b.seller_id}`,title:b.name,subtitle:'Business · seller',kind:'seller' as const})),
 ];
 const[selected,setSelected]=useState('buyer');
 useEffect(()=>{if(state.signedOut) router.refresh();},[state,router]);
 return <form className="oauth-consent" action={action}>
  {Object.entries(params).map(([key,value])=>value===undefined?null:<input key={key} type="hidden" name={key} value={value}/>)}
  <fieldset className="oauth-choices">
   <legend>Choose what to connect</legend>
   {choices.map(choice=>{const Icon=choice.kind==='buyer'?ShoppingBag:Store;const active=selected===choice.value;return <label key={choice.value} className={`oauth-choice ${active?'selected':''}`}>
    <input type="radio" name="target" value={choice.value} checked={active} onChange={()=>setSelected(choice.value)} disabled={pending}/>
    <span className="oauth-choice-head"><span className="oauth-choice-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.6}/></span><span className="oauth-choice-name"><strong>{choice.title}</strong><small>{choice.subtitle}</small></span><span className="oauth-radio" aria-hidden="true"/></span>
    <ul className="oauth-allows" aria-label={`What ${choice.title} allows`}>{allows[choice.kind].map(item=><li key={item}><Check size={13} aria-hidden="true"/>{item}</li>)}</ul>
   </label>;})}
  </fieldset>
  {state.error&&<p className="form-error" role="alert">{state.error}</p>}
  <div className="oauth-actions">
   <button className="button secondary" name="decision" value="deny" disabled={pending} onClick={()=>setClicked('deny')}>{pending&&clicked==='deny'?<Loader2 className="spin" size={16}/>:null}Deny</button>
   <button className="button primary" name="decision" value="approve" disabled={pending} onClick={()=>setClicked('approve')}>{pending&&clicked==='approve'?<Loader2 className="spin" size={16}/>:null}Approve</button>
  </div>
 </form>;
}

export function SignOutButton() {
 const router=useRouter();
 const[pending,start]=useTransition();
 return <button type="button" className="inline-button" disabled={pending} onClick={()=>start(async()=>{await signOutForConsent();router.refresh();})}>{pending?'Signing out…':'Sign out'}</button>;
}
