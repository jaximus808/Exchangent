import {cookies} from 'next/headers';
import {NextRequest,NextResponse} from 'next/server';

const ID='[0-9a-f-]{36}';
// Only these commerce paths can reach the server; no arbitrary URL proxying.
const allowed=new RegExp('^(?:'+[
 'me',
 `buy-requests(?:/${ID}(?:/(?:offers|conversation))?)?`,
 `offers/${ID}/reservations`,
 `reservations/${ID}(?:/checkout)?`,
 // Buyer orders and problem cases.
 `orders(?:/${ID}(?:/(?:received|cases))?)?`,
 `cases/${ID}(?:/(?:respond|evidence))?`,
 // Businesses the signed-in person owns.
 `businesses(?:/${ID}(?:/(?:sessions|inventory|orders|cases|policy))?)?`,
 `businesses/${ID}/orders/${ID}/(?:ship|simulate-delivery)`,
 `businesses/${ID}/cases/${ID}/(?:respond|return-received)`,
].join('|')+')$','i');

const LOOPBACK=new Set(['localhost','127.0.0.1','[::1]']);
/**
 * Origins allowed to write. WEB_ORIGIN (comma-separated) when set; otherwise this request's own origin. In local
 * development the loopback aliases of that origin are also accepted (Next can report localhost while the browser
 * sends 127.0.0.1). The Host header is never trusted.
 */
function allowedOrigins(req:NextRequest):Set<string> {
 const configured=(process.env.WEB_ORIGIN??'').split(',').map(o=>o.trim().replace(/\/+$/,'')).filter(Boolean);
 if(configured.length) return new Set(configured);
 const own=new URL(req.nextUrl.origin);
 const origins=new Set([own.origin]);
 if(process.env.NODE_ENV!=='production'&&LOOPBACK.has(own.hostname)) for(const host of LOOPBACK) origins.add(`${own.protocol}//${host}${own.port?`:${own.port}`:''}`);
 return origins;
}

async function handle(req:NextRequest,{params}:{params:Promise<{path:string[]}>}) {
 const path=(await params).path.join('/');
 if(!allowed.test(path)) return NextResponse.json({error:{message:'Not found'}},{status:404});
 const token=(await cookies()).get('insforge_access_token')?.value;
 if(!token) return NextResponse.json({error:{message:'Please sign in to continue.'}},{status:401});
 const origin=req.headers.get('origin');
 if(req.method!=='GET'&&(!origin||!allowedOrigins(req).has(origin))) return NextResponse.json({error:{message:'Invalid request origin'}},{status:403});
 const base=process.env.COMMERCE_API_URL??'http://127.0.0.1:8787';
 try {
  const response=await fetch(`${base}/api/v1/${path}`,{method:req.method,
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json',
    ...(req.headers.get('idempotency-key')?{'idempotency-key':req.headers.get('idempotency-key')!}:{})},
   body:req.method==='GET'?undefined:await req.text(),cache:'no-store',signal:AbortSignal.timeout(15000)});
  return new NextResponse(await response.text(),{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 } catch {return NextResponse.json({error:{message:'Your workspace couldn’t be reached. Please try again.'}},{status:503});}
}
export {handle as GET,handle as POST,handle as PATCH,handle as PUT};
