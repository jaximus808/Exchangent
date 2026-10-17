import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@insforge/sdk';
import { CommerceError } from './commerce.ts';
import type { Commerce } from './commerce.ts';
import type { Db, DelegationRow, DelegationScope, Principal, Row } from './types.ts';

export const hashToken=(token: string)=>createHash('sha256').update(token).digest('hex');
const requestScopes: ReadonlySet<string>=new Set<DelegationScope>(['request:read','reservation:write','checkout:write']);
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function bearer(header: string | undefined) {
  const match=/^Bearer ([A-Za-z0-9._~-]{1,8192})$/.exec(header??'');
  if(!match) throw new CommerceError('unauthorized',401);
  return match[1];
}
export function requireUser(principal: Principal) {
  if(principal.kind!=='user') throw new CommerceError('user_session_required',403);
}
export function authorize(principal: Principal,scope: DelegationScope,{requestId,sellerId}: {requestId?: string; sellerId?: string}={}) {
  if(principal.kind==='user') return;
  if(!principal.scopes.includes(scope) ||
     (requestId && principal.requestId!==requestId) ||
     (sellerId && principal.sellerId!==sellerId)) throw new CommerceError('forbidden',403);
}
export interface VerifiedUser { id: string }
export interface AuthOptions {
  commerce: Commerce;
  verifyUser: (token: string)=>Promise<VerifiedUser | null | undefined>;
  now?: ()=>number;
}
export interface Delegation {
  id: string; scopes: DelegationScope[]; request_id: string | null; seller_id: string | null; expires_at: string;
  /** Plaintext credential, returned once. */
  token: string;
}
export class Auth {
  commerce: Commerce; db: Db; verifyUser: AuthOptions['verifyUser']; now: ()=>number;
  constructor({commerce,verifyUser,now=()=>Date.now()}: AuthOptions) {
    this.commerce=commerce;this.db=commerce.db;this.verifyUser=verifyUser;this.now=now;
  }
  async authenticate(header: string | undefined): Promise<Principal> {
    const token=bearer(header);
    if(token.startsWith('exg_')) {
      const {data,error}=await this.db.database.from('commerce_delegations')
        .select('id,actor_id,request_id,seller_id,scopes,expires_at,revoked_at').eq('token_hash',hashToken(token)).limit(1);
      if(error) throw new CommerceError('authentication_unavailable',503);
      const grant=data?.[0] as DelegationRow | undefined;
      const expires=Date.parse(grant?.expires_at as string);
      if(!grant||grant.revoked_at||!Number.isFinite(expires)||expires<=this.now()) throw new CommerceError('unauthorized',401);
      return {kind:'delegation',actorId:grant.actor_id,delegationId:grant.id,
        requestId:grant.request_id,sellerId:grant.seller_id,scopes:grant.scopes};
    }
    const user=await this.verifyUser(token);
    if(!user?.id || !UUID.test(user.id)) throw new CommerceError('unauthorized',401);
    const actorId=await this.commerce.rpc<string>('commerce_actor_for_user',{p_user:user.id,p_label:'Exchangent user'});
    return {kind:'user',actorId,userId:user.id};
  }
  async createDelegation(principal: Principal,input: Record<string, unknown>): Promise<Delegation> {
    requireUser(principal);
    const {request_id:requestId,seller_id:sellerId,scopes,ttl_seconds:ttl=3600}=input;
    const target=requestId??sellerId;
    if(Boolean(requestId)===Boolean(sellerId) || typeof target!=='string' || !UUID.test(target) ||
       typeof ttl!=='number' || !Number.isInteger(ttl)||ttl<300||ttl>86400 || !Array.isArray(scopes)||!scopes.length||scopes.length>3||
       new Set(scopes).size!==scopes.length) throw new CommerceError('invalid_delegation',400);
    const allowed: ReadonlySet<string>=requestId?requestScopes:new Set(['seller:read']);
    if(!scopes.every((s: unknown)=>typeof s==='string'&&allowed.has(s))) throw new CommerceError('invalid_scope',400);
    const row=await this.commerce.row<Row>(requestId?'commerce_requests':'commerce_sellers',target);
    if(row[requestId?'buyer_id':'owner_id']!==principal.actorId) throw new CommerceError('forbidden',403);
    const token='exg_'+randomBytes(32).toString('base64url');
    const expires=new Date(this.now()+ttl*1000).toISOString();
    const {data,error}=await this.db.database.from('commerce_delegations').insert([{
      actor_id:principal.actorId,token_hash:hashToken(token),request_id:requestId??null,seller_id:sellerId??null,
      scopes,expires_at:expires,
    }]).select('id,scopes,request_id,seller_id,expires_at');
    if(error) throw new CommerceError('delegation_failed',503);
    return {...(data![0] as Omit<Delegation,'token'>),token}; // Returned once. Never logged or persisted in plaintext.
  }
  async revoke(principal: Principal,id: string) {
    requireUser(principal);
    if(!UUID.test(id)) throw new CommerceError('invalid_id',400);
    const {error}=await this.db.database.from('commerce_delegations').update({revoked_at:new Date(this.now()).toISOString()})
      .eq('id',id).eq('actor_id',principal.actorId);
    if(error) throw new CommerceError('delegation_failed',503);
    return {revoked:true};
  }
}
export function authFromEnv(commerce: Commerce,env: NodeJS.ProcessEnv=process.env) {
  if(!env.INSFORGE_ANON_KEY) throw new CommerceError('missing_anon_key',500);
  return new Auth({commerce,verifyUser:async(token)=>{
    // A fresh server-mode SDK client makes a verified upstream session request.
    // Never decode JWT payloads locally and trust their user ID or roles.
    const client=createClient({baseUrl:env.INSFORGE_URL,anonKey:env.INSFORGE_ANON_KEY,
      accessToken:token,timeout:10000,retryCount:0});
    const {data,error}=await client.auth.getCurrentUser();
    if(error) {
      if(error.statusCode>=500) throw new CommerceError('authentication_unavailable',503);
      throw new CommerceError('unauthorized',401);
    }
    return data?.user;
  }});
}
