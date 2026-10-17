// Vercel entry point: the same handler as src/server.mjs, served as one Node function.
// vercel.json rewrites every path here; req.url keeps the original path for routing.
// Setup is lazy so a misconfigured deployment answers with the failing check
// (e.g. missing_INSFORGE_URL) instead of crashing every request.
import { fromEnv } from '../src/commerce.mjs';
import { Negotiation } from '../src/negotiation.mjs';
import { createHandler } from '../src/http.mjs';
let handler;
export default async function exchangent(req,res) {
 try {
  if(!handler) {
   const commerce=fromEnv();
   const negotiation=new Negotiation({db:commerce.db,demoToken:process.env.COMMERCE_DEMO_TOKEN,demoBuyerId:process.env.DEMO_BUYER_ID});
   handler=createHandler({commerce,negotiation});
  }
 } catch(error) {
  const code=/^[a-z_A-Z]+$/.test(error?.code??'')?error.code:'configuration_error';
  res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});
  return res.end(JSON.stringify({error:{code,message:'The backend is not configured.',
   next_action:'Set the missing or invalid environment variable in Vercel (see backend/SETUP.md) and redeploy.'}}));
 }
 return handler(req,res);
}
