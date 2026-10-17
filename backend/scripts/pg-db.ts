// Local-only stand-in for the InsForge admin client, backed by a direct Postgres
// connection (devDependency `pg`). Implements the same `Db` interface as the SDK
// client (src/types.ts): database.rpc(name,args) and from(table) with
// select().eq().order().limit(), insert().select(), upsert, update().eq() and delete().like().
// Used by `npm run test:db` against a throwaway container; never for InsForge.
import pg from 'pg';
import type { Db, DbRead, DbResult, DbUpdate, Row } from '../src/types.ts';
const ident=(s: string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);return s;};
const value=(v: unknown)=>v!==null&&typeof v==='object'?JSON.stringify(v):v;
const columns=(list: string)=>list==='*'?list:list.split(',').map(c=>ident(c.trim())).join(',');
type Filter=[column: string, value: unknown];
const where=(filters: Filter[],first: number)=>filters.length?' WHERE '+filters.map(([c],i)=>`${ident(c)}=$${first+i}`).join(' AND '):'';
export interface PgDb extends Db { end: ()=>Promise<void>; pool: pg.Pool }
export function pgDb(connectionString: string): PgDb {
 const pool=new pg.Pool({connectionString,max:8});
 const run=async(sql: string,params?: unknown[]): Promise<DbResult<Row[]>>=>{
  try {const {rows}=await pool.query(sql,params);return {data:rows,error:null};}
  catch(e) {const {message,code}=e as {message: string; code?: string};return {data:null,error:{message,code}};}
 };
 const write=async(table: string,rows: Row|Row[],conflict: string|null,returning?: string): Promise<DbResult<Row[]>>=>{
  rows=Array.isArray(rows)?rows:[rows];
  const cols=[...new Set(rows.flatMap(Object.keys))].map(ident);
  const list=cols.join(',');
  let sql=`INSERT INTO public.${ident(table)}(${list}) SELECT ${list} FROM jsonb_populate_recordset(null::public.${ident(table)},$1::jsonb)`;
  if(conflict) sql+=` ON CONFLICT (${ident(conflict)}) DO UPDATE SET ${cols.map(c=>`${c}=EXCLUDED.${c}`).join(',')}`;
  if(returning) sql+=` RETURNING ${columns(returning)}`;
  const {data,error}=await run(sql,[JSON.stringify(rows)]);return {data:returning?data:null,error};
 };
 const select=(table: string,list: string)=>{
  const filters: Filter[]=[];let order='';
  const q: DbRead={eq:(c,v)=>{filters.push([c,v]);return q;},
   order:(c,{ascending=true}={})=>{order=` ORDER BY ${ident(c)} ${ascending?'ASC':'DESC'}`;return q;},
   limit:n=>run(`SELECT ${columns(list)} FROM public.${ident(table)}${where(filters,1)}${order} LIMIT ${Math.trunc(n)}`,
    filters.map(([,v])=>value(v))),
   then:(ok,fail)=>run(`SELECT ${columns(list)} FROM public.${ident(table)}${where(filters,1)}${order}`,
    filters.map(([,v])=>value(v))).then(ok,fail)};
  return q;
 };
 const update=(table: string,values: Row)=>{
  const sets=Object.keys(values).map(ident),filters: Filter[]=[];
  const exec=async(): Promise<DbResult>=>{const {error}=await run(`UPDATE public.${ident(table)} SET ${sets.map((c,i)=>`${c}=$${i+1}`).join(',')}${where(filters,sets.length+1)}`,
   [...sets.map(c=>value(values[c])),...filters.map(([,v])=>value(v))]);return {data:null,error};};
  const q: DbUpdate={eq:(c,v)=>{filters.push([c,v]);return q;},then:(ok,fail)=>exec().then(ok,fail)};
  return q;
 };
 return {end:()=>pool.end(),pool,database:{
  async rpc(name,args={}) {
   const keys=Object.keys(args).map(ident);
   const {data,error}=await run(`SELECT public.${ident(name)}(${keys.map((k,i)=>`${k} => $${i+1}`).join(', ')}) AS r`,
    keys.map(k=>value(args[k])));
   return error?{data:null,error}:{data:data![0].r,error:null};
  },
  from(table) {
   return {select:list=>select(table,list),update:values=>update(table,values),
    // Lazy like the SDK builder: runs once when awaited, or with RETURNING via select().
    insert:rows=>({then:(ok,fail)=>write(table,rows,null).then(ok,fail),select:list=>write(table,rows,null,list)}),
    upsert:(rows,{onConflict='id'}={})=>write(table,rows,onConflict),
    delete:()=>({like:(col,pattern)=>run(`DELETE FROM public.${ident(table)} WHERE ${ident(col)} LIKE $1`,[pattern])})};
  },
 }};
}
