// Vercel entry point: the same app as `npm start` (src/server.mjs createApp), served as
// one Node function. vercel.json rewrites every path here; req.url keeps the original path.
// Setup is lazy so a misconfigured deployment answers with the failing check
// (e.g. missing_INSFORGE_URL) instead of crashing every request.
import { fromEnv } from '../src/commerce.mjs';
import { authFromEnv } from '../src/auth.mjs';
import { createApp } from '../src/server.mjs';
let handler;
export default async function exchangent(req,res) {
 try {
  if(!handler) {
   const commerce=fromEnv();
   // createApp returns an unstarted http.Server; Vercel needs only its request listener.
   handler=createApp({commerce,auth:authFromEnv(commerce)}).listeners('request')[0];
  }
 } catch(error) {
  const code=/^[a-z_A-Z]+$/.test(error?.code??'')?error.code:'configuration_error';
  res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});
  return res.end(JSON.stringify({error:{code,message:'The backend is not configured.',
   next_action:'Set the missing or invalid environment variable in Vercel (see backend/SETUP.md) and redeploy.'}}));
 }
 return handler(req,res);
}
