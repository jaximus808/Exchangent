'use server';
import {cookies} from 'next/headers';
import {redirect} from 'next/navigation';
import {clearAuthCookies,createAuthActions} from '@insforge/sdk/ssr';
import {denyRedirectUrl,isRedirectToFor,paramsFromFormData,parseNewBusiness,parseTarget,type ConsentTarget} from '@/lib/oauth';
import {fetchTargets,postAuthorize,postBusiness,sessionToken} from './backend';

/** refresh: re-render the page so a business created on this attempt appears as a choice. */
export type ConsentState={error?:string;signedOut?:boolean;refresh?:boolean};

const authorizeErrors:Record<string,string>={
 invalid_client:'This assistant is no longer registered with Exchangent. Start the connection again from your assistant.',
 invalid_redirect_uri:'This connection link has an unrecognized return address. Start the connection again from your assistant.',
 forbidden:'You don’t own that business. Choose your buyer account or a business you own.',
 not_found:'That business could not be found. Choose another account.',
 invalid_request:'This connection request is incomplete. Start the connection again from your assistant.',
};

const businessErrors:Record<string,string>={
 business_name_taken:'Another business already uses that name. If it’s yours, choose it above; otherwise pick a different name.',
 business_limit:'You already own the maximum of 5 businesses. Choose one of them above.',
 invalid_input:'Check the business details: a name of 2–80 characters, a delivery fee from $0 to $1,000 and 0–30 delivery days.',
};

/**
 * Approve or deny. Every input is re-validated here: the OAuth parameters and the
 * chosen target come from the form, and the InsForge token is read from the cookie.
 */
export async function decideConsent(_prev:ConsentState,form:FormData):Promise<ConsentState> {
 const parsed=paramsFromFormData(form);
 if(!parsed.ok) return {error:parsed.reason};
 const params=parsed.params;
 const token=await sessionToken();
 if(!token) return {error:'Your session ended. Sign in again to continue.',signedOut:true};
 const decision=form.get('decision');

 if(decision==='deny') {
  // Only send the person back once the backend confirms this client registered the redirect_uri.
  const targets=await fetchTargets(token,params);
  if(!targets.ok) {
   if(targets.kind==='unauthorized') return {error:'Your session ended. Sign in again to continue.',signedOut:true};
   if(targets.kind==='unavailable') return {error:'We couldn’t reach Exchangent. Please try again.'};
   return {error:authorizeErrors[targets.kind]??authorizeErrors.invalid_request};
  }
  redirect(denyRedirectUrl(params));
 }

 if(decision!=='approve') return {error:'Choose Approve or Deny.'};
 let target:ConsentTarget|null;
 let created=false;
 if(form.get('target')==='new_business') {
  const business=parseNewBusiness(form);
  if(!business.ok) return {error:business.error};
  const made=await postBusiness(token,business.body);
  if(!made.ok) {
   if(made.status===401||(made.status===403&&made.code==='user_session_required')) return {error:'Your session ended. Sign in again to continue.',signedOut:true};
   if(made.status>=500) return {error:'We couldn’t reach Exchangent. Please try again.'};
   return {error:businessErrors[made.code]??'We couldn’t create that business. Check the details and try again.'};
  }
  target={kind:'seller',seller_id:made.seller_id};
  created=true;
 } else target=parseTarget(form.get('target'));
 if(!target) return {error:'Choose the account you want to connect.'};
 const result=await postAuthorize(token,params,target);
 // The business exists now even if connecting failed: show it as a choice instead of creating it again.
 if(!result.ok&&created) return {error:'Your business was created, but connecting it failed. Choose it above and approve again.',refresh:true};
 if(!result.ok) {
  if(result.status===401||(result.status===403&&result.code==='user_session_required')) return {error:'Your session ended. Sign in again to continue.',signedOut:true};
  if(result.status===403) return {error:authorizeErrors.forbidden};
  if(result.status>=500) return {error:'We couldn’t reach Exchangent. Please try again.'};
  return {error:authorizeErrors[result.code]??'We couldn’t complete the connection. Start again from your assistant.'};
 }
 if(!isRedirectToFor(result.redirect_to,params.redirect_uri)) return {error:'Exchangent returned an unexpected response. Please try again.'};
 redirect(result.redirect_to);
}

/** "Not you?" Ends the InsForge session and clears the auth cookies even if InsForge is unreachable. */
export async function signOutForConsent():Promise<{ok:boolean}> {
 const store=await cookies();
 let ok=true;
 if(process.env.NEXT_PUBLIC_INSFORGE_URL&&process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY) {
  try {
   const {error}=await createAuthActions({cookies:store}).signOut();
   ok=!error;
  } catch {ok=false;}
 }
 clearAuthCookies(store);
 return {ok};
}
