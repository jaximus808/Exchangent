import type {Metadata} from 'next';
import {AlertCircle,LockKeyhole,ShieldCheck} from 'lucide-react';
import {parseAuthorizeParams} from '@/lib/oauth';
import {fetchTargets,sessionToken} from './backend';
import {ConsentForm,SignOutButton} from './consent-form';
import {OAuthSignIn} from './sign-in-form';
import './oauth.css';

// Per-request: reads the session cookie and must never be cached or prerendered.
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Connect Exchangent',robots:{index:false,follow:false},referrer:'no-referrer'};

type SearchParams=Promise<Record<string,string|string[]|undefined>>;

function Brand() {
 return <span className="brand brand-small oauth-brand"><span className="brand-symbol" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 8h14m-4-4 4 4-4 4M19 16H5m4-4-4 4 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg></span><span>exchangent<span className="brand-period">.</span></span></span>;
}

function Shell({children}:{children:React.ReactNode}) {
 return <main className="oauth-page"><div className="oauth-card"><Brand/>{children}</div><p className="oauth-footer"><LockKeyhole size={12} aria-hidden="true"/>Exchangent never shares your password or payment details with your assistant.</p></main>;
}

function ErrorView({title,message,retry}:{title:string;message:string;retry?:boolean}) {
 return <Shell><div className="oauth-error" role="alert"><AlertCircle size={22} strokeWidth={1.6} aria-hidden="true"/><h1>{title}</h1><p>{message}</p></div>
  {retry?<a className="button secondary full" href="">Try again</a>:<p className="fine-print">Close this tab and start the connection again from Claude, ChatGPT or your other assistant.</p>}</Shell>;
}

function SignInView({expired}:{expired?:boolean}) {
 const configured=Boolean(process.env.NEXT_PUBLIC_INSFORGE_URL&&process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY);
 if(!configured) return <ErrorView title="Sign-in is unavailable" message="Exchangent sign-in isn’t configured on this server yet, so your assistant can’t be connected right now. Please try again later."/>;
 return <Shell>
  <div className="oauth-heading"><h1>Sign in to connect your assistant</h1><p>Use any email address to sign in or sign up. A new email creates your Exchangent account; next you choose to buy, or to sell as a business you own or create now.</p></div>
  {expired&&<p className="form-error" role="status">Your session ended. Sign in again to continue.</p>}
  <OAuthSignIn/>
  <p className="fine-print">No password to remember. You’ll choose exactly what to connect on the next step.</p>
 </Shell>;
}

export default async function AuthorizePage({searchParams}:{searchParams:SearchParams}) {
 const parsed=parseAuthorizeParams(await searchParams);
 // Invalid requests never redirect anywhere: redirect_uri is unvalidated at this point.
 if(!parsed.ok) return <ErrorView title="This connection link isn’t valid" message={parsed.reason}/>;
 const params=parsed.params;

 const token=await sessionToken();
 if(!token) return <SignInView/>;

 const targets=await fetchTargets(token,params);
 if(!targets.ok) {
  switch(targets.kind) {
   case 'unauthorized': return <SignInView expired/>;
   case 'invalid_client': return <ErrorView title="Unknown assistant" message="This assistant isn’t registered with Exchangent, so it can’t be connected."/>;
   case 'invalid_redirect_uri': return <ErrorView title="This connection link isn’t valid" message="The return address in this link isn’t registered for this assistant, so Exchangent won’t send you there."/>;
   case 'invalid_request': return <ErrorView title="This connection link isn’t valid" message="Exchangent couldn’t read this connection request."/>;
   default: return <ErrorView title="We couldn’t reach Exchangent" message="Something went wrong on our side. Your account hasn’t been connected." retry/>;
  }
 }

 const {client,account,businesses}=targets.data;
 const returnHost=new URL(params.redirect_uri).host;
 return <Shell>
  <div className="oauth-heading"><span className="oauth-kicker"><ShieldCheck size={14} aria-hidden="true"/>Connection request</span><h1><span className="oauth-client">{client.name}</span> wants to use your Exchangent account</h1>
   <p className="oauth-account">Signed in as <strong>{account.email}</strong>. Not you? <SignOutButton/></p></div>
  <ConsentForm params={params} email={account.email} businesses={businesses}/>
  <p className="fine-print">Approving sends you back to <span className="mono">{returnHost}</span>. You can connect a different account later by reconnecting.</p>
 </Shell>;
}
