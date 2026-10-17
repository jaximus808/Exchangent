import { createServer } from 'node:http';
import { fromEnv } from './commerce.mjs';
import { Negotiation } from './negotiation.mjs';
import { createHandler } from './http.mjs';
const commerce=fromEnv();
// Principals: sha256(bearer) in commerce_principals; the legacy demo token still maps to DEMO_BUYER_ID.
const negotiation=new Negotiation({db:commerce.db,demoToken:process.env.COMMERCE_DEMO_TOKEN,demoBuyerId:process.env.DEMO_BUYER_ID});
export const server=createServer(createHandler({commerce,negotiation}));
// Loopback only: demo tokens are not a public authentication scheme.
server.listen(Number(process.env.PORT??8787),'127.0.0.1',()=>console.log('Exchangent test backend: http://127.0.0.1:8787'));
