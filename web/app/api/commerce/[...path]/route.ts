import {cookies} from 'next/headers';
import {NextRequest,NextResponse} from 'next/server';
// Only these commerce paths can reach the server; no arbitrary URL proxying.
const allowed=/^(?:me|buy-requests(?:\/[0-9a-f-]{36}(?:\/(?:offers|conversation))?)?|businesses(?:\/[0-9a-f-]{36}(?:\/(?:sessions|inventory))?)?|offers\/[0-9a-f-]{36}\/reservations|reservations\/[0-9a-f-]{36}(?:\/checkout)?)$/i;
async function handle(req:NextRequest,{params}:{params:Promise<{path:string[]}>}) {
 const path=(await params).path.join('/');
 if(!allowed.test(path)) return NextResponse.json({error:{message:'Not found'}},{status:404});
 const token=(await cookies()).get('insforge_access_token')?.value;
 if(!token) return NextResponse.json({error:{message:'Please sign in to continue.'}},{status:401});
 const origin=req.headers.get('origin');
 // Same-origin writes only. Next's nextUrl.origin can name localhost while the browser says 127.0.0.1, so the
 // Origin's host is also accepted when it equals the request's Host header.
 const sameHost=(()=>{try{return !!origin&&new URL(origin).host===req.headers.get('host');}catch{return false;}})();
 if(req.method!=='GET'&&origin!==req.nextUrl.origin&&!sameHost) return NextResponse.json({error:{message:'Invalid request origin'}},{status:403});
 const base=process.env.COMMERCE_API_URL??'http://127.0.0.1:8787';
 try {
  const response=await fetch(`${base}/api/v1/${path}`,{method:req.method,
   headers:{authorization:`Bearer ${token}`,'content-type':'application/json',
    ...(req.headers.get('idempotency-key')?{'idempotency-key':req.headers.get('idempotency-key')!}:{})},
   body:req.method==='GET'?undefined:await req.text(),cache:'no-store',signal:AbortSignal.timeout(15000)});
  return new NextResponse(await response.text(),{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
 } catch {return NextResponse.json({error:{message:'Your workspace couldn’t be reached. Please try again.'}},{status:503});}
}
export {handle as GET,handle as POST,handle as PATCH};
