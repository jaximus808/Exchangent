// Database client for admin scripts: DATABASE_URL (local Postgres via scripts/pg-db.ts,
// e.g. the test:db container) or the InsForge admin client from backend/.env.local.
import type { Db } from '../src/types.ts';

export type ScriptDb=Db & {end?: ()=>Promise<void>};
export async function scriptDb(env: NodeJS.ProcessEnv=process.env): Promise<ScriptDb> {
 if(env.DATABASE_URL) return (await import('./pg-db.ts')).pgDb(env.DATABASE_URL);
 if(!env.INSFORGE_URL||!env.INSFORGE_API_KEY) throw new Error('Set INSFORGE_URL and INSFORGE_API_KEY (backend/.env.local) or DATABASE_URL');
 const {createAdminClient}=await import('@insforge/sdk');
 const {asDb}=await import('../src/commerce.ts');
 return asDb(createAdminClient({baseUrl:env.INSFORGE_URL,apiKey:env.INSFORGE_API_KEY}));
}
/** `--name value` options; flags listed in `repeat` collect every occurrence. */
export function parseArgs(argv: string[],{repeat=[],flags=[]}: {repeat?: string[]; flags?: string[]}={}) {
 const out: Record<string, string | string[] | true>={};
 for(let i=0;i<argv.length;i++) {
  const arg=argv[i];
  if(!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
  const [name,inline]=arg.slice(2).split(/=(.*)/s,2);
  if(flags.includes(name)) {out[name]=true;continue;}
  const value=inline??argv[++i];
  if(value===undefined) throw new Error(`--${name} needs a value`);
  if(repeat.includes(name)) out[name]=[...((out[name] as string[] | undefined)??[]),value];
  else out[name]=value;
 }
 return out;
}
