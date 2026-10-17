// Register or update the MCP server's OAuth client (doc/oauth-contract.md, "Demo setup").
//   npm run oauth:client -- --name "Exchangent MCP" --redirect-uri <MCP_URL>/mcp/oauth/callback [--redirect-uri ...]
//     [--env-file ../mcp/.env.production.local] [--client-id <id>] [--rotate-secret]
// Credentials come from EXCHANGENT_OAUTH_CLIENT_ID / EXCHANGENT_OAUTH_CLIENT_SECRET (process env,
// or --env-file, which wins). Without a secret, an existing client keeps its secret; a new
// client (or --rotate-secret) gets a generated one, printed once. Only sha256(secret) is stored.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { hashToken } from '../src/auth.ts';
import { parseArgs, scriptDb } from './script-db.ts';

const CLIENT_ID=/^[A-Za-z0-9._~-]{8,200}$/;
function checkRedirectUri(value: string) {
 let url: URL;
 try {url=new URL(value);} catch {throw new Error(`Not an absolute URL: ${value}`);}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&local)) throw new Error(`Redirect URIs must use https (http only for localhost): ${value}`);
 if(value.includes('#')||url.username||url.password) throw new Error(`Redirect URIs cannot have a fragment or credentials: ${value}`);
 return value;
}

const args=parseArgs(process.argv.slice(2),{repeat:['redirect-uri'],flags:['rotate-secret']});
const name=typeof args.name==='string'?args.name.trim():'Exchangent MCP';
const uris=((args['redirect-uri'] as string[] | undefined)??[]).map(checkRedirectUri);
if(!uris.length) throw new Error('Pass at least one --redirect-uri (the MCP proxy callback: <MCP_URL>/mcp/oauth/callback)');
if(!name||name.length>100) throw new Error('--name must be 1-100 characters');
const fileEnv=typeof args['env-file']==='string'?parseEnv(readFileSync(args['env-file'],'utf8')):{};
const fromEnv=(key: string)=>(fileEnv[key]??process.env[key])?.trim()||undefined;
let clientId=(typeof args['client-id']==='string'?args['client-id']:undefined)??fromEnv('EXCHANGENT_OAUTH_CLIENT_ID');
let secret=args['rotate-secret']?undefined:fromEnv('EXCHANGENT_OAUTH_CLIENT_SECRET');
const secretSource=secret?(fileEnv.EXCHANGENT_OAUTH_CLIENT_SECRET?`--env-file ${args['env-file']}`:'EXCHANGENT_OAUTH_CLIENT_SECRET'):null;
if(secret&&secret.length<32) throw new Error('EXCHANGENT_OAUTH_CLIENT_SECRET must be at least 32 characters');
clientId??='exchangent-mcp-'+randomBytes(6).toString('hex');
if(!CLIENT_ID.test(clientId)) throw new Error('client_id must be 8-200 characters of A-Z a-z 0-9 . _ ~ -');

const db=await scriptDb();
const upsert=(hash: string | null)=>db.database.rpc('commerce_oauth_upsert_client',
 {p_client_id:clientId,p_name:name,p_redirect_uris:uris,p_secret_hash:hash});
let generated=false;
let {data,error}=secret?await upsert(hashToken(secret)):args['rotate-secret']?{data:null,error:{message:'client_not_found'}}:await upsert(null);
if(error?.message==='client_not_found') {
 secret=randomBytes(32).toString('base64url');generated=true;
 ({data,error}=await upsert(hashToken(secret)));
}
await db.end?.();
if(error) throw new Error(`commerce_oauth_upsert_client failed: ${error.message}`);
const result=data as {client_id: string; name: string; redirect_uris: string[]; created: boolean; secret_changed: boolean};
console.log(JSON.stringify({...result,
 client_secret:generated?secret:secretSource?`(from ${secretSource}; not printed)`:'(unchanged; not printed)'},null,2));
if(generated) console.error('\nStore client_id and client_secret now as EXCHANGENT_OAUTH_CLIENT_ID and EXCHANGENT_OAUTH_CLIENT_SECRET'+
 ' in the MCP server environment (never in git). The secret is not shown again; only its sha256 digest is stored.');
