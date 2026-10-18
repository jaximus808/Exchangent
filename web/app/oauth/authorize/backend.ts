// Server-side calls to the commerce backend for the OAuth consent flow.
// Imported only by the page (server component) and server actions.
import {cookies} from 'next/headers';
import {authorizeBody,type AuthorizeParams,type ConsentTarget,type NewBusiness} from '@/lib/oauth';

export type Targets={
 client:{client_id:string;name:string};
 account:{actor_id:string;email:string};
 businesses:{seller_id:string;name:string}[];
};

export type TargetsResult=
 |{ok:true;data:Targets}
 |{ok:false;kind:'unauthorized'}
 |{ok:false;kind:'invalid_client'|'invalid_redirect_uri'|'invalid_request'}
 |{ok:false;kind:'unavailable'};

export type AuthorizeResult=
 |{ok:true;redirect_to:unknown}
 |{ok:false;status:number;code:string};

const commerceBase=()=>(process.env.COMMERCE_API_URL??'http://127.0.0.1:8787').replace(/\/+$/,'');

/**
 * The InsForge session token, read from the session cookie on the server. Never accepted from the client.
 * Note: the InsForge SDK sets this cookie without httpOnly, so page scripts could read it; nothing here relies on
 * it being httpOnly, and the app renders no untrusted HTML.
 */
export async function sessionToken():Promise<string|null> {
 const value=(await cookies()).get('insforge_access_token')?.value;
 return value&&value.length<8192?value:null;
}

async function errorCode(response:Response):Promise<string> {
 try {
  const body=await response.json() as {error?:unknown};
  if(typeof body.error==='string') return body.error;
  if(body.error&&typeof body.error==='object'&&'code' in body.error&&typeof body.error.code==='string') return body.error.code;
 } catch { /* fall through */ }
 return '';
}

function isTargets(value:unknown):value is Targets {
 if(!value||typeof value!=='object') return false;
 const v=value as Partial<Targets>;
 return typeof v.client?.name==='string'&&typeof v.client.client_id==='string'&&
  typeof v.account?.email==='string'&&Array.isArray(v.businesses)&&
  v.businesses.every(b=>b&&typeof b.seller_id==='string'&&typeof b.name==='string');
}

export async function fetchTargets(token:string,params:Pick<AuthorizeParams,'client_id'|'redirect_uri'>):Promise<TargetsResult> {
 const query=new URLSearchParams({client_id:params.client_id,redirect_uri:params.redirect_uri});
 let response:Response;
 try {
  response=await fetch(`${commerceBase()}/api/v1/oauth/targets?${query}`,{
   headers:{authorization:`Bearer ${token}`,accept:'application/json'},
   cache:'no-store',signal:AbortSignal.timeout(15000)});
 } catch {return {ok:false,kind:'unavailable'};}
 if(response.status===401||response.status===403) return {ok:false,kind:'unauthorized'};
 if(response.status===400) {
  const code=await errorCode(response);
  return {ok:false,kind:code==='invalid_client'||code==='invalid_redirect_uri'?code:'invalid_request'};
 }
 if(!response.ok) return {ok:false,kind:'unavailable'};
 try {
  const body=await response.json() as {data?:unknown};
  return isTargets(body.data)?{ok:true,data:body.data}:{ok:false,kind:'unavailable'};
 } catch {return {ok:false,kind:'unavailable'};}
}

export async function postAuthorize(token:string,params:AuthorizeParams,target:ConsentTarget):Promise<AuthorizeResult> {
 let response:Response;
 try {
  response=await fetch(`${commerceBase()}/api/v1/oauth/authorize`,{method:'POST',
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify(authorizeBody(params,target)),cache:'no-store',signal:AbortSignal.timeout(15000)});
 } catch {return {ok:false,status:503,code:'unavailable'};}
 if(!response.ok) return {ok:false,status:response.status,code:await errorCode(response)};
 try {
  const body=await response.json() as {data?:{redirect_to?:unknown}};
  return {ok:true,redirect_to:body.data?.redirect_to};
 } catch {return {ok:false,status:502,code:'bad_response'};}
}

export type CreateBusinessResult=
 |{ok:true;seller_id:string;name:string}
 |{ok:false;status:number;code:string};

/** Creates a business owned by the signed-in person (POST /api/v1/businesses, user session). */
export async function postBusiness(token:string,business:NewBusiness):Promise<CreateBusinessResult> {
 let response:Response;
 try {
  response=await fetch(`${commerceBase()}/api/v1/businesses`,{method:'POST',
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json'},
   body:JSON.stringify(business),cache:'no-store',signal:AbortSignal.timeout(15000)});
 } catch {return {ok:false,status:503,code:'unavailable'};}
 if(!response.ok) return {ok:false,status:response.status,code:await errorCode(response)};
 try {
  const body=await response.json() as {data?:{seller_id?:unknown;name?:unknown}};
  const id=body.data?.seller_id;
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return {ok:false,status:502,code:'bad_response'};
  return {ok:true,seller_id:id,name:typeof body.data?.name==='string'?body.data.name:business.name};
 } catch {return {ok:false,status:502,code:'bad_response'};}
}
