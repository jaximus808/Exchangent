'use client';
import {useState,useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowRight,Loader2} from 'lucide-react';
import {requestSignIn,verifySignIn} from '@/app/actions';

/** Email one-time-code sign-in. Any email works; a new email creates the account. Re-renders the page on success. */
export function SignInForm({cta='Open your workspace',onDone}:{cta?:string;onDone?:()=>void}) {
 const router=useRouter();
 const[email,setEmail]=useState('');const[code,setCode]=useState('');const[sent,setSent]=useState(false);
 const[error,setError]=useState('');const[done,setDone]=useState(false);const[pending,start]=useTransition();
 const busy=pending||done;
 return <form className="stack-form" onSubmit={e=>{e.preventDefault();setError('');start(async()=>{
  const result=sent?await verifySignIn(email,code):await requestSignIn(email);
  if(result.error) setError(result.error);
  else if(sent) {setDone(true);onDone?.();router.refresh();}
  else setSent(true);
 });}}>
  <label>Email address<input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required readOnly={sent}/></label>
  {sent&&<label>Verification code<input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value)} placeholder="000000" autoFocus required/><span className="field-help">We sent a six-digit code to {email}. New here? Verifying it creates your account.</span></label>}
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={busy}>{busy?<Loader2 className="spin" size={17}/>:null}{sent?cta:'Email me a sign-in code'}{!busy&&<ArrowRight size={17}/>}</button>
  {sent&&<button type="button" className="text-button centered" disabled={busy} onClick={()=>{setSent(false);setCode('');setError('');}}>Use a different email or request a new code</button>}
 </form>;
}
