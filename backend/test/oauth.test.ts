import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { OAuth, OAuthError, clientCredentials, mediaType, parseTokenBody, pkceS256, redirectWithCode, secretMatches } from '../src/oauth.ts';
import { Auth, hashToken } from '../src/auth.ts';
import { Negotiation } from '../src/negotiation.ts';
import { createApp } from '../src/server.ts';
import type { Commerce } from '../src/commerce.ts';
import type { Db, Principal, UserPrincipal } from '../src/types.ts';
// Test doubles implement only what each case touches.
const stub=<T,>(value: unknown)=>value as T;
const oauthError=(error: string)=>(e: unknown)=>e instanceof OAuthError&&e.error===error;
const basic=(id: string,secret: string)=>'Basic '+Buffer.from(`${id}:${secret}`).toString('base64');

test('PKCE S256 matches RFC 7636 appendix B',()=>{
 assert.equal(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
 assert.notEqual(pkceS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('token bodies: form with or without charset, JSON, duplicates and other types rejected',()=>{
 const form=Buffer.from('grant_type=authorization_code&code=abc&redirect_uri=https%3A%2F%2Fmcp.example%2Fmcp%2Foauth%2Fcallback&client_secret=s%2Bx');
 for(const type of ['application/x-www-form-urlencoded;charset=UTF-8','application/x-www-form-urlencoded','Application/X-WWW-Form-Urlencoded; charset=utf-8']) {
  const body=parseTokenBody(type,form);
  assert.equal(body.grant_type,'authorization_code');assert.equal(body.redirect_uri,'https://mcp.example/mcp/oauth/callback');
  assert.equal(body.client_secret,'s+x');
 }
 assert.equal(mediaType('application/json; charset=utf-8'),'application/json');
 assert.deepEqual({...parseTokenBody('application/json; charset=utf-8',Buffer.from('{"grant_type":"refresh_token","refresh_token":"exr_1","scope":null}'))},
  {grant_type:'refresh_token',refresh_token:'exr_1'});
 assert.throws(()=>parseTokenBody('application/x-www-form-urlencoded',Buffer.from('code=a&code=b')),oauthError('invalid_request'));
 assert.throws(()=>parseTokenBody('application/json',Buffer.from('{"code":1}')),oauthError('invalid_request'));
 assert.throws(()=>parseTokenBody('application/json',Buffer.from('[1]')),oauthError('invalid_request'));
 assert.throws(()=>parseTokenBody('application/json',Buffer.from('{bad')),oauthError('invalid_request'));
 assert.throws(()=>parseTokenBody('text/plain',form),oauthError('invalid_request'));
 assert.throws(()=>parseTokenBody(undefined,form),oauthError('invalid_request'));
});

test('client authentication: client_secret_post, Basic, both agreeing, conflicts and missing',()=>{
 assert.deepEqual(clientCredentials(undefined,{client_id:'exchangent-mcp',client_secret:'s3cret'}),{clientId:'exchangent-mcp',clientSecret:'s3cret'});
 // RFC 6749 section 2.3.1: id and secret are form-encoded before base64.
 assert.deepEqual(clientCredentials(basic('exchangent-mcp','a%3Ab+c'),{}),{clientId:'exchangent-mcp',clientSecret:'a:b c'});
 assert.deepEqual(clientCredentials(basic('exchangent-mcp','x'),{client_id:'exchangent-mcp'}),{clientId:'exchangent-mcp',clientSecret:'x'});
 assert.deepEqual(clientCredentials(basic('exchangent-mcp','x'),{client_id:'exchangent-mcp',client_secret:'x'}),{clientId:'exchangent-mcp',clientSecret:'x'});
 assert.throws(()=>clientCredentials(basic('exchangent-mcp','x'),{client_id:'exchangent-mcp',client_secret:'y'}),oauthError('invalid_request'));
 assert.throws(()=>clientCredentials(basic('exchangent-mcp','x'),{client_id:'other'}),oauthError('invalid_request'));
 for(const [header,body] of [[undefined,{}],[undefined,{client_id:'exchangent-mcp'}],[undefined,{client_secret:'x'}],
  ['Basic !!!',{}],['Basic '+Buffer.from('no-colon').toString('base64'),{}],['Bearer exc_x',{client_id:'a'}]] as const)
  assert.throws(()=>clientCredentials(header,{...body}),oauthError('invalid_client'));
});

test('redirect keeps the registered query, adds code and state, never iss',()=>{
 assert.equal(redirectWithCode('https://mcp.example/mcp/oauth/callback','abc','s 1'),'https://mcp.example/mcp/oauth/callback?code=abc&state=s+1');
 assert.equal(redirectWithCode('https://mcp.example/cb?tenant=a%20b','abc','xyz'),'https://mcp.example/cb?tenant=a%20b&code=abc&state=xyz');
 assert.equal(redirectWithCode('https://mcp.example/cb?','abc'),'https://mcp.example/cb?code=abc');
 const url=new URL(redirectWithCode('http://127.0.0.1:3000/mcp/oauth/callback','c','st'));
 assert.deepEqual([...url.searchParams.keys()],['code','state']);
});

test('secrets are compared by sha256 digest in constant time',()=>{
 assert.equal(secretMatches('s3cret',hashToken('s3cret')),true);
 assert.equal(secretMatches('s3creT',hashToken('s3cret')),false);
 for(const stored of [undefined,null,'','00'.repeat(32),'zz']) assert.equal(secretMatches('s3cret',stored),false);
});

test('authorize validates PKCE, target and scope before touching the database',async()=>{
 const calls: string[]=[];
 const oauth=new OAuth({db:stub<Db>({database:{rpc:async(name: string)=>{calls.push(name);return {data:{},error:null};}}})});
 const user: UserPrincipal={kind:'user',actorId:randomUUID(),userId:randomUUID(),email:'a@example.com'};
 const good={client_id:'exchangent-mcp',redirect_uri:'https://mcp.example/cb',scope:'buyer seller',state:'st',
  code_challenge:pkceS256('v'.repeat(43)),code_challenge_method:'S256',target:{kind:'buyer'}};
 const delegated=stub<Principal>({kind:'delegation',actorId:user.actorId,scopes:['request:read']});
 await assert.rejects(oauth.authorize(delegated,good),/user_session_required/);
 for(const bad of [{code_challenge:undefined},{code_challenge_method:'plain'},{code_challenge:'short'},{target:{kind:'worker'}},
  {target:{kind:'seller'}},{target:{kind:'seller',seller_id:'x'}},{client_id:''},{redirect_uri:undefined},{state:5}])
  await assert.rejects(oauth.authorize(user,{...good,...bad}),/invalid_request/,JSON.stringify(bad));
 await assert.rejects(oauth.authorize(user,{...good,scope:'seller'}),/invalid_scope/);
 assert.equal(calls.length,0);
 const {redirect_to}=await oauth.authorize(user,good);
 const url=new URL(redirect_to);
 assert.equal(url.origin+url.pathname,'https://mcp.example/cb');assert.equal(url.searchParams.get('state'),'st');
 assert.match(url.searchParams.get('code')!,/^[A-Za-z0-9_-]{43}$/);assert.deepEqual(calls,['commerce_oauth_issue_code']);
});

test('connector tokens resolve by hash to negotiation principals and never reach InsForge',async()=>{
 const token='exc_'+'a'.repeat(43);let args: Record<string, unknown> | undefined,name='';
 const n=new Negotiation({db:{database:{rpc:async(fn,input)=>{name=fn;args=input;
  return {data:{kind:'connector',scope:'seller',actor_id:'a',seller_id:'s',client_id:'c'},error:null};}}}});
 const p=await n.principal(`Bearer ${token}`);
 assert.equal(name,'commerce_resolve_connector');assert.equal(args?.p_token_hash,hashToken(token));
 assert.deepEqual(n.whoami(p),{kind:'connector',scope:'seller',actor_id:'a',seller_id:'s',client_id:'c'});
 const auth=new Auth({commerce:stub<Commerce>({db:{}}),verifyUser:async()=>assert.fail('must not verify with InsForge')});
 for(const t of [token,'exr_'+'b'.repeat(43)]) await assert.rejects(auth.authenticate(`Bearer ${t}`),/unauthorized/);
});

test('token endpoint over HTTP: RFC errors, no-store, Pragma, routed before bearer auth',async t=>{
 const secret='s3cret-value';
 const db=stub<Db>({database:{
  from:()=>({select:()=>({eq:()=>({limit:async()=>({data:[{client_id:'exchangent-mcp',secret_hash:hashToken(secret),revoked_at:null}],error:null})})})}),
  rpc:async()=>({data:{error:'invalid_grant',reason:'code_expired'},error:null}),
 }});
 const server=createApp({commerce:stub<Commerce>({db}),oauth:new OAuth({db}),
  auth:stub<Auth>({authenticate:async()=>assert.fail('token endpoint must not authenticate a bearer')})});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/oauth/token`;
 const post=async(body: string,headers: Record<string,string>={'content-type':'application/x-www-form-urlencoded;charset=UTF-8'})=>{
  const res=await fetch(url,{method:'POST',headers,body});
  assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(res.headers.get('pragma'),'no-cache');
  assert.match(res.headers.get('content-type')!,/^application\/json/);
  return {status:res.status,body:await res.json() as {error?: string; error_description?: string},headers:res.headers};
 };
 let r=await post(`grant_type=password&client_id=exchangent-mcp&client_secret=${secret}`);
 assert.deepEqual([r.status,r.body.error],[400,'unsupported_grant_type']);
 r=await post('grant_type=authorization_code&client_id=exchangent-mcp&client_secret=wrong&code=c&redirect_uri=x&code_verifier='+'v'.repeat(43));
 assert.deepEqual([r.status,r.body.error],[401,'invalid_client']);assert.ok(r.headers.get('www-authenticate'));
 r=await post(`grant_type=authorization_code&client_id=exchangent-mcp&client_secret=${secret}&code=c&redirect_uri=x`);
 assert.deepEqual([r.status,r.body.error],[400,'invalid_request']);
 r=await post(`grant_type=authorization_code&client_id=exchangent-mcp&client_secret=${secret}&code=c&redirect_uri=x&code_verifier=${'v'.repeat(43)}`);
 assert.deepEqual([r.status,r.body.error,r.body.error_description],[400,'invalid_grant','The authorization code expired.']);
 r=await post(JSON.stringify({grant_type:'refresh_token'}),{'content-type':'application/json',authorization:basic('exchangent-mcp',secret)});
 assert.deepEqual([r.status,r.body.error],[400,'invalid_request']);
 assert.ok(!JSON.stringify(r.body).includes(secret));
 const get=await fetch(url);assert.equal(get.status,405);
});
