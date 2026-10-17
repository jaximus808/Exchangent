// Vercel entry point: the same app as `npm start` (src/server.ts createApp), served as
// one Node function. vercel.json rewrites every path here; req.url keeps the original path.
// Setup is lazy so a misconfigured deployment answers with the failing check
// (e.g. missing_INSFORGE_URL) instead of crashing every request.
// Imports the compiled dist/ (vercel.json buildCommand runs `npm run build`): Vercel
// compiles this file itself but is not relied on to resolve `.ts` imports from ../src.
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { fromEnv } from '../dist/commerce.js';
import { authFromEnv } from '../dist/auth.js';
import { createApp } from '../dist/server.js';
let handler: RequestListener | undefined;
export default async function exchangent(req: IncomingMessage,res: ServerResponse) {
 try {
  if(!handler) {
   const commerce=fromEnv();
   // createApp returns an unstarted http.Server; Vercel needs only its request listener.
   handler=createApp({commerce,auth:authFromEnv(commerce)}).listeners('request')[0] as RequestListener;
  }
 } catch(error) {
  const raw=(error as {code?: unknown} | null)?.code;
  const code=/^[a-z_A-Z]+$/.test(String(raw??''))?raw as string:'configuration_error';
  res.writeHead(500,{'Content-Type':'application/json','Cache-Control':'no-store'});
  return res.end(JSON.stringify({error:{code,message:'The backend is not configured.',
   next_action:'Set the missing or invalid environment variable in Vercel (see backend/SETUP.md) and redeploy.'}}));
 }
 return handler(req,res);
}
