// Connector OAuth (doc/oauth-contract.md): consent targets, code issuance and the
// RFC 6749 token endpoint for the MCP proxy. Codes, tokens and client secrets are
// stored only as sha256 hex; single-use redemption and refresh rotation run in SQL
// (migrations/20261018000200_connector-oauth.sql) under a row lock.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CommerceError } from './commerce.ts';
import { hashToken, UUID } from './auth.ts';
import type { Db, ErrorCode, Principal, UserPrincipal } from './types.ts';

export const ACCESS_TOKEN_TTL=3600;
const MAX_BODY=65536;
export const PKCE_VALUE=/^[A-Za-z0-9._~-]{43,128}$/;
const printable=/^[\x20-\x7e]*$/;

// ---------- Pure helpers ----------
/** RFC 6749 section 5.2 error, rendered by the token endpoint without the {data} envelope. */
export class OAuthError extends Error {
  error: 'invalid_request'|'invalid_client'|'invalid_grant'|'unsupported_grant_type'|'temporarily_unavailable';
  status: number; description?: string;
  constructor(error: OAuthError['error'],description?: string,status=error==='invalid_client'?401:error==='temporarily_unavailable'?503:400) {
    super(error);this.error=error;this.status=status;this.description=description;
  }
}
/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export const pkceS256=(verifier: string)=>createHash('sha256').update(verifier,'ascii').digest('base64url');
/** Constant-time comparison of a presented secret with a stored sha256 hex digest. */
export function secretMatches(secret: string,storedHash: unknown) {
  const actual=Buffer.from(hashToken(secret),'hex');
  const expected=typeof storedHash==='string'&&/^[0-9a-f]{64}$/.test(storedHash)?Buffer.from(storedHash,'hex'):Buffer.alloc(32);
  return timingSafeEqual(actual,expected)&&expected.some(b=>b!==0);
}
/** `type/subtype` in lowercase, without parameters such as `;charset=UTF-8`. */
export const mediaType=(header: string | undefined)=>(header??'').split(';')[0].trim().toLowerCase();

/**
 * Token request body: application/x-www-form-urlencoded (any `;charset` suffix) or JSON.
 * Every parameter is a single string; repeated form parameters are rejected (RFC 6749 section 3.2).
 */
export function parseTokenBody(contentType: string | undefined,raw: Buffer): Record<string, string> {
  const type=mediaType(contentType),text=raw.toString('utf8');
  const out: Record<string, string>=Object.create(null);
  if(type==='application/x-www-form-urlencoded') {
    for(const [k,v] of new URLSearchParams(text)) {
      if(k in out) throw new OAuthError('invalid_request',`The ${k} parameter was sent more than once.`);
      out[k]=v;
    }
    return out;
  }
  if(type==='application/json') {
    let input: unknown;
    try {input=JSON.parse(text);} catch {throw new OAuthError('invalid_request','The body is not valid JSON.');}
    if(!input||typeof input!=='object'||Array.isArray(input)) throw new OAuthError('invalid_request','The body must be a JSON object.');
    for(const [k,v] of Object.entries(input)) {
      if(v==null) continue;
      if(typeof v!=='string') throw new OAuthError('invalid_request',`The ${k} parameter must be a string.`);
      out[k]=v;
    }
    return out;
  }
  throw new OAuthError('invalid_request','Send application/x-www-form-urlencoded or application/json.');
}

/**
 * Client authentication: HTTP Basic (RFC 6749 section 2.3.1, form-encoded id and secret)
 * or client_secret_post. Using both is allowed only when they agree.
 */
export function clientCredentials(authorization: string | undefined,body: Record<string, string>) {
  let basic: {clientId: string; clientSecret: string} | undefined;
  const header=authorization?.trim()??'';
  if(/^basic\s/i.test(header)) {
    const encoded=header.slice(6).trim();
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new OAuthError('invalid_client','Malformed Basic credentials.');
    const decoded=Buffer.from(encoded,'base64').toString('utf8'),colon=decoded.indexOf(':');
    if(colon<1) throw new OAuthError('invalid_client','Malformed Basic credentials.');
    const formDecode=(s: string)=>{try {return decodeURIComponent(s.replace(/\+/g,' '));} catch {throw new OAuthError('invalid_client','Malformed Basic credentials.');}};
    basic={clientId:formDecode(decoded.slice(0,colon)),clientSecret:formDecode(decoded.slice(colon+1))};
  }
  const post=body.client_secret!==undefined?{clientId:body.client_id,clientSecret:body.client_secret}:undefined;
  if(basic) {
    if((post&&(post.clientId!==basic.clientId||post.clientSecret!==basic.clientSecret))||
       (body.client_id!==undefined&&body.client_id!==basic.clientId))
      throw new OAuthError('invalid_request','Use one client authentication method.');
    return basic;
  }
  if(!post?.clientId||!post.clientSecret) throw new OAuthError('invalid_client','Client authentication is required.');
  return post as {clientId: string; clientSecret: string};
}

/** redirect_uri plus code and state. The registered URI's own query is kept byte for byte. */
export function redirectWithCode(redirectUri: string,code: string,state?: string) {
  const params=new URLSearchParams({code});
  if(state!==undefined) params.set('state',state);
  const sep=redirectUri.includes('?')?(/[?&]$/.test(redirectUri)?'':'&'):'?';
  return redirectUri+sep+params.toString();
}

// ---------- OAuth service ----------
export interface TokenResponse {
  access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: 'buyer'|'seller';
}
export interface ConsentTargets {
  client: {client_id: string; name: string};
  account: {actor_id: string; email: string};
  businesses: {seller_id: string; name: string}[];
}
interface ClientRow { client_id: string; secret_hash: string; revoked_at: string | null }
type IssueResult={error?: string; reason?: string; scope: 'buyer'|'seller'; expires_in: number};
const STATUS: Partial<Record<ErrorCode, number>>={invalid_client:400,invalid_redirect_uri:400,invalid_request:400,invalid_scope:400,forbidden:403};
const REASONS: Record<string, string>={unknown_code:'The authorization code is invalid.',code_reused:'The authorization code was already used.',
  code_expired:'The authorization code expired.',redirect_uri_mismatch:'redirect_uri does not match the authorization request.',
  pkce_mismatch:'code_verifier does not match the code challenge.',seller_access_lost:'The account no longer owns that business.',
  unknown_refresh_token:'The refresh token is invalid.',grant_revoked:'The grant was revoked.',
  refresh_token_reused:'The refresh token was already used; the grant is revoked.',refresh_token_expired:'The refresh token expired.',
  client_revoked:'The client is no longer registered.'};
const token=(prefix: string)=>prefix+randomBytes(32).toString('base64url');
function str(input: Record<string, unknown>,key: string,max: number,{optional=false}={}) {
  const value=input[key];
  if(value==null&&optional) return undefined;
  if(typeof value!=='string'||!value.length||value.length>max||!printable.test(value)) throw new CommerceError('invalid_request',400);
  return value;
}
function userSession(principal: Principal): UserPrincipal {
  if(principal.kind!=='user') throw new CommerceError('user_session_required',403);
  return principal;
}

export class OAuth {
  db: Db;
  constructor({db}: {db: Db}) {this.db=db;}
  async rpc<T>(name: string,args: Record<string, unknown>): Promise<T> {
    const {data,error}=await this.db.database.rpc(name,args);
    if(error) {
      const code=/^[a-z_]+$/.test(error.message??'')?error.message:'database_error';
      throw new CommerceError(code,STATUS[code]??(code==='database_error'?503:409));
    }
    return data as T;
  }
  /** GET /api/v1/oauth/targets: what the signed-in person may connect. */
  async targets(principal: Principal,query: URLSearchParams): Promise<ConsentTargets> {
    const user=userSession(principal);
    if(query.getAll('client_id').length!==1||query.getAll('redirect_uri').length!==1) throw new CommerceError('invalid_request',400);
    const input=Object.fromEntries(query);
    const t=await this.rpc<Omit<ConsentTargets,'account'>>('commerce_oauth_targets',{p_client_id:str(input,'client_id',200),
      p_redirect_uri:str(input,'redirect_uri',2048),p_actor:user.actorId});
    return {client:t.client,account:{actor_id:user.actorId,email:user.email??''},businesses:t.businesses};
  }
  /** POST /api/v1/oauth/authorize: consent approved; returns the redirect carrying a single-use code. */
  async authorize(principal: Principal,input: Record<string, unknown>) {
    const user=userSession(principal);
    const clientId=str(input,'client_id',200),redirectUri=str(input,'redirect_uri',2048);
    const state=str(input,'state',1024,{optional:true});
    const scope=input.scope==null||input.scope===''?'':str(input,'scope',1024) as string;
    const challenge=input.code_challenge,method=input.code_challenge_method??'S256';
    if(typeof challenge!=='string'||!PKCE_VALUE.test(challenge)||method!=='S256') throw new CommerceError('invalid_request',400);
    const target=input.target as {kind?: unknown; seller_id?: unknown} | null | undefined;
    if(!target||typeof target!=='object'||(target.kind!=='buyer'&&target.kind!=='seller')) throw new CommerceError('invalid_request',400);
    const sellerId=target.kind==='seller'?target.seller_id:null;
    if(target.kind==='seller'&&(typeof sellerId!=='string'||!UUID.test(sellerId))) throw new CommerceError('invalid_request',400);
    // A client that asked for specific roles cannot receive a different one.
    const requested=scope.split(' ').filter(Boolean);
    if(requested.some(s=>s==='buyer'||s==='seller')&&!requested.includes(target.kind)) throw new CommerceError('invalid_scope',400);
    const code=token('');
    await this.rpc('commerce_oauth_issue_code',{p_code_hash:hashToken(code),p_client_id:clientId,p_redirect_uri:redirectUri,
      p_actor:user.actorId,p_kind:target.kind,p_seller:sellerId,p_scope:scope,p_code_challenge:challenge,p_code_challenge_method:'S256'});
    return {redirect_to:redirectWithCode(redirectUri as string,code,state)};
  }
  async authenticateClient(authorization: string | undefined,body: Record<string, string>) {
    const {clientId,clientSecret}=clientCredentials(authorization,body);
    let row: ClientRow | undefined;
    if(clientId.length<=200) {
      const {data,error}=await this.db.database.from('commerce_oauth_clients').select('client_id,secret_hash,revoked_at')
        .eq('client_id',clientId).limit(1);
      if(error) throw new OAuthError('temporarily_unavailable');
      row=data?.[0] as ClientRow | undefined;
    }
    // Always hash and compare, so unknown clients take the same path as wrong secrets.
    const matches=secretMatches(clientSecret,row?.secret_hash);
    if(!row||row.revoked_at||!matches) throw new OAuthError('invalid_client','Client authentication failed.');
    return row.client_id;
  }
  /** POST /api/v1/oauth/token body handling. Throws OAuthError. */
  async token(authorization: string | undefined,body: Record<string, string>): Promise<TokenResponse> {
    const grantType=body.grant_type;
    if(!grantType) throw new OAuthError('invalid_request','grant_type is required.');
    const clientId=await this.authenticateClient(authorization,body);
    const access=token('exc_'),refresh=token('exr_');
    let result: IssueResult;
    if(grantType==='authorization_code') {
      const {code,redirect_uri:redirectUri,code_verifier:verifier}=body;
      if(!code||!redirectUri) throw new OAuthError('invalid_request','code and redirect_uri are required.');
      if(!verifier) throw new OAuthError('invalid_request','code_verifier is required.');
      if(!PKCE_VALUE.test(verifier)) throw new OAuthError('invalid_grant','code_verifier is malformed.');
      result=await this.issue('commerce_oauth_redeem_code',{p_code_hash:hashToken(code),p_client_id:clientId,
        p_redirect_uri:redirectUri,p_code_challenge:pkceS256(verifier),p_access_hash:hashToken(access),p_refresh_hash:hashToken(refresh)});
    } else if(grantType==='refresh_token') {
      if(!body.refresh_token) throw new OAuthError('invalid_request','refresh_token is required.');
      result=await this.issue('commerce_oauth_refresh',{p_refresh_hash:hashToken(body.refresh_token),p_client_id:clientId,
        p_access_hash:hashToken(access),p_new_refresh_hash:hashToken(refresh)});
    } else throw new OAuthError('unsupported_grant_type');
    return {access_token:access,token_type:'Bearer',expires_in:result.expires_in??ACCESS_TOKEN_TTL,refresh_token:refresh,scope:result.scope};
  }
  async issue(name: string,args: Record<string, unknown>): Promise<IssueResult> {
    const {data,error}=await this.db.database.rpc(name,args);
    if(error) throw new OAuthError('temporarily_unavailable');
    const result=data as IssueResult;
    if(result?.error) throw new OAuthError(result.error==='invalid_client'?'invalid_client':'invalid_grant',REASONS[result.reason??'']);
    return result;
  }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[]=[];let bytes=0;
  for await(const chunk of req as AsyncIterable<Buffer>) {
    bytes+=chunk.length;
    if(bytes>MAX_BODY) throw new OAuthError('invalid_request','The request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
/** RFC 6749 token endpoint. Plain OAuth JSON (no {data} envelope), never cached, never logs credentials. */
export async function tokenEndpoint(oauth: OAuth,req: IncomingMessage,res: ServerResponse) {
  const send=(status: number,payload: unknown,extra: Record<string, string>={})=>{
    res.writeHead(status,{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store','Pragma':'no-cache',...extra});
    res.end(JSON.stringify(payload));
  };
  try {
    if(req.method!=='POST') return send(405,{error:'invalid_request',error_description:'Use POST.'},{Allow:'POST'});
    const body=parseTokenBody(req.headers['content-type'],await readBody(req));
    return send(200,await oauth.token(req.headers.authorization,body));
  } catch(error) {
    if(error instanceof OAuthError) return send(error.status,{error:error.error,...(error.description?{error_description:error.description}:{})},
      error.status===401?{'WWW-Authenticate':'Basic realm="exchangent", charset="UTF-8"'}:{});
    // Only the error class: request bodies and headers carry credentials.
    console.error('oauth token endpoint failure',error instanceof Error?error.name:'unknown');
    return send(500,{error:'server_error'});
  }
}
