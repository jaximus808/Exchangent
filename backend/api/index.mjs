// Vercel entry point: the same handler as src/server.mjs, served as one Node function.
// vercel.json rewrites every path here; req.url keeps the original path for routing.
import { fromEnv } from '../src/commerce.mjs';
import { Negotiation } from '../src/negotiation.mjs';
import { createHandler } from '../src/http.mjs';
const commerce=fromEnv();
const negotiation=new Negotiation({db:commerce.db,demoToken:process.env.COMMERCE_DEMO_TOKEN,demoBuyerId:process.env.DEMO_BUYER_ID});
export default createHandler({commerce,negotiation});
