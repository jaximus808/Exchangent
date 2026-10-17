// Local-only stand-in for the InsForge admin client, backed by a direct Postgres
// connection (devDependency `pg`). Implements just what the backend and seed use:
// database.rpc(name,args) and from(table).insert/upsert/delete().like().
// Used by `npm run test:db` against a throwaway container; never for InsForge.
import pg from 'pg';
const ident=s=>{if(!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);return s;};
const value=v=>v!==null&&typeof v==='object'?JSON.stringify(v):v;
export function pgDb(connectionString) {
 const pool=new pg.Pool({connectionString,max:8});
 const run=async(sql,params)=>{
  try {const {rows}=await pool.query(sql,params);return {data:rows,error:null};}
  catch(e) {return {data:null,error:{message:e.message,code:e.code}};}
 };
 const write=async(table,rows,conflict)=>{
  rows=Array.isArray(rows)?rows:[rows];
  const cols=[...new Set(rows.flatMap(Object.keys))].map(ident);
  const list=cols.join(',');
  let sql=`INSERT INTO public.${ident(table)}(${list}) SELECT ${list} FROM jsonb_populate_recordset(null::public.${ident(table)},$1::jsonb)`;
  if(conflict) sql+=` ON CONFLICT (${ident(conflict)}) DO UPDATE SET ${cols.map(c=>`${c}=EXCLUDED.${c}`).join(',')}`;
  const {error}=await run(sql,[JSON.stringify(rows)]);return {data:null,error};
 };
 return {end:()=>pool.end(),pool,database:{
  async rpc(name,args={}) {
   const keys=Object.keys(args).map(ident);
   const {data,error}=await run(`SELECT public.${ident(name)}(${keys.map((k,i)=>`${k} => $${i+1}`).join(', ')}) AS r`,
    keys.map(k=>value(args[k])));
   return error?{data:null,error}:{data:data[0].r,error:null};
  },
  from(table) {
   return {insert:rows=>write(table,rows,null),upsert:(rows,{onConflict='id'}={})=>write(table,rows,onConflict),
    delete:()=>({like:(col,pattern)=>run(`DELETE FROM public.${ident(table)} WHERE ${ident(col)} LIKE $1`,[pattern])})};
  },
 }};
}
