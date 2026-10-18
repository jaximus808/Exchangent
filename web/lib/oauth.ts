// Pure helpers for the connector OAuth authorize page (doc/oauth-contract.md).
// No secrets live here; network calls are in app/oauth/authorize/backend.ts.

export type AuthorizeParams={
 response_type:'code';
 client_id:string;
 redirect_uri:string;
 state?:string;
 scope:string;
 code_challenge?:string;
 code_challenge_method?:'S256';
};

export type ParseResult={ok:true;params:AuthorizeParams}|{ok:false;reason:string};

export type ConsentTarget={kind:'buyer'}|{kind:'seller';seller_id:string};

type RawParams=Record<string,string|string[]|undefined>;

export const OAUTH_FIELDS=['response_type','client_id','redirect_uri','state','scope','code_challenge','code_challenge_method'] as const;

const LIMITS={client_id:200,redirect_uri:2048,state:1024,scope:1024};
// RFC 6749 printable ASCII without control characters.
const printable=/^[\x20-\x7e]*$/;
const pkceChallenge=/^[A-Za-z0-9\-._~]{43,128}$/;

/** Reads one OAuth parameter. Repeated parameters are invalid (RFC 6749 §3.1). */
function single(raw:RawParams,key:string):{value?:string;repeated:boolean} {
 const value=raw[key];
 if(Array.isArray(value)) return value.length>1?{repeated:true}:{value:value[0],repeated:false};
 return {value,repeated:false};
}

/**
 * Validates the authorize query. Never trust redirect_uri beyond this structural check:
 * the backend targets call is what proves the client registered it.
 */
export function parseAuthorizeParams(raw:RawParams):ParseResult {
 const values:Partial<Record<(typeof OAUTH_FIELDS)[number],string>>={};
 for(const key of OAUTH_FIELDS) {
  const {value,repeated}=single(raw,key);
  if(repeated) return {ok:false,reason:`The ${key} parameter was sent more than once.`};
  if(value!==undefined&&value!=='') values[key]=value;
 }
 if(values.response_type!=='code') return {ok:false,reason:'This connection link asks for an unsupported response type.'};
 const client_id=values.client_id;
 if(!client_id||client_id.length>LIMITS.client_id||!printable.test(client_id)) return {ok:false,reason:'This connection link is missing a valid client ID.'};
 const redirect_uri=values.redirect_uri;
 if(!redirect_uri||redirect_uri.length>LIMITS.redirect_uri||!isAcceptableRedirectUri(redirect_uri)) return {ok:false,reason:'This connection link is missing a valid return address.'};
 const state=values.state;
 if(state!==undefined&&(state.length>LIMITS.state||!printable.test(state))) return {ok:false,reason:'This connection link has an invalid state value.'};
 const scope=values.scope??'';
 if(scope.length>LIMITS.scope||!printable.test(scope)) return {ok:false,reason:'This connection link has an invalid scope.'};
 const challenge=values.code_challenge;
 const method=values.code_challenge_method;
 if(challenge===undefined&&method!==undefined) return {ok:false,reason:'This connection link has a PKCE method without a challenge.'};
 if(challenge!==undefined) {
  if(method!=='S256') return {ok:false,reason:'This connection link must use the S256 code challenge method.'};
  if(!pkceChallenge.test(challenge)) return {ok:false,reason:'This connection link has an invalid code challenge.'};
 }
 const params:AuthorizeParams={response_type:'code',client_id,redirect_uri,scope};
 if(state!==undefined) params.state=state;
 if(challenge!==undefined) {params.code_challenge=challenge;params.code_challenge_method='S256';}
 return {ok:true,params};
}

/** Structural check only: absolute http(s) URL with no fragment or credentials (RFC 6749 §3.1.2). */
export function isAcceptableRedirectUri(value:string):boolean {
 let url:URL;
 try {url=new URL(value);} catch {return false;}
 if(url.protocol!=='https:'&&url.protocol!=='http:') return false;
 if(url.hash||value.includes('#')) return false;
 if(url.username||url.password) return false;
 return true;
}

export function paramsFromFormData(form:FormData):ParseResult {
 const raw:RawParams={};
 for(const key of OAUTH_FIELDS) {
  const values=form.getAll(key).filter((v):v is string=>typeof v==='string');
  raw[key]=values.length>1?values:values[0];
 }
 return parseAuthorizeParams(raw);
}

/** Target radio values: "buyer" or "seller:<seller_id>". */
export function parseTarget(value:unknown):ConsentTarget|null {
 if(value==='buyer') return {kind:'buyer'};
 if(typeof value==='string'&&value.startsWith('seller:')) {
  const seller_id=value.slice(7);
  if(/^[A-Za-z0-9_-]{1,100}$/.test(seller_id)) return {kind:'seller',seller_id};
 }
 return null;
}

/** Body for POST /api/v1/businesses (doc/signup-contract.md), parsed from the "Create a business" fields. */
export type NewBusiness={name:string;delivery_cents?:number;delivery_days?:number};

/**
 * Reads the consent form's new-business fields: a required name (2-80 characters), an optional
 * delivery fee in dollars (0-1000, converted to integer cents) and optional delivery days (0-30).
 * The backend re-validates everything.
 */
export function parseNewBusiness(form:FormData):{ok:true;body:NewBusiness}|{ok:false;error:string} {
 const text=(key:string)=>{const v=form.get(key);return typeof v==='string'?v.trim():'';};
 const name=text('business_name').replace(/\s+/g,' ');
 if(name.length<2||name.length>80) return {ok:false,error:'Enter a business name between 2 and 80 characters.'};
 const body:NewBusiness={name};
 const fee=text('delivery_fee').replace(/^\$/,'');
 if(fee) {
  if(!/^\d{1,4}(\.\d{1,2})?$/.test(fee)||Number(fee)>1000) return {ok:false,error:'Enter a delivery fee in dollars, from 0 to 1000.'};
  body.delivery_cents=Math.round(Number(fee)*100);
 }
 const days=text('delivery_days');
 if(days) {
  if(!/^\d{1,2}$/.test(days)||Number(days)>30) return {ok:false,error:'Enter delivery days as a whole number from 0 to 30.'};
  body.delivery_days=Number(days);
 }
 return {ok:true,body};
}

export function denyRedirectUrl(params:AuthorizeParams):string {
 const url=new URL(params.redirect_uri);
 url.searchParams.set('error','access_denied');
 if(params.state!==undefined) url.searchParams.set('state',params.state);
 return url.toString();
}

/** The backend builds redirect_to; only follow it if it points at the validated redirect_uri. */
export function isRedirectToFor(redirectTo:unknown,redirectUri:string):redirectTo is string {
 if(typeof redirectTo!=='string') return false;
 try {
  const target=new URL(redirectTo);
  const expected=new URL(redirectUri);
  return target.origin===expected.origin&&target.pathname===expected.pathname&&!target.hash&&
   (target.searchParams.has('code')||target.searchParams.has('error'));
 } catch {return false;}
}

export function authorizeBody(params:AuthorizeParams,target:ConsentTarget) {
 return {
  client_id:params.client_id,
  redirect_uri:params.redirect_uri,
  scope:params.scope,
  ...(params.state!==undefined?{state:params.state}:{}),
  ...(params.code_challenge?{code_challenge:params.code_challenge,code_challenge_method:params.code_challenge_method}:{}),
  target,
 };
}
