// Make a signed-up Exchangent person the owner of one business, so it appears on their
// connector consent screen (doc/oauth-contract.md, "Demo setup").
//   npm run assign:seller -- --email <person@example.com> --seller "Bay Desk Co"   (name or seller UUID)
// The person must have signed in once (InsForge auth.users). Their actor is created if needed.
import { parseArgs, scriptDb } from './script-db.ts';

const args=parseArgs(process.argv.slice(2));
if(typeof args.email!=='string'||typeof args.seller!=='string') throw new Error('Usage: assign:seller -- --email <email> --seller "<business name or id>"');
const db=await scriptDb();
const {data,error}=await db.database.rpc('commerce_assign_seller',{p_email:args.email,p_seller:args.seller});
await db.end?.();
if(error) {
 const hint: Record<string, string>={user_not_found:'No InsForge user has that email. Sign in once on the web app first.',
  seller_not_found:'No business has that name or ID. Run seed:negotiation or check the name.',
  ambiguous_seller:'Several businesses share that name. Pass the seller UUID instead.'};
 throw new Error(`commerce_assign_seller failed: ${error.message}${hint[error.message]?` (${hint[error.message]})`:''}`);
}
const r=data as {seller_name: string; seller_id: string; actor_id: string; previous_owner_id: string; changed: boolean; enabled: boolean};
console.log(JSON.stringify(r,null,2));
console.log(r.changed?`${r.seller_name} is now owned by actor ${r.actor_id} (was ${r.previous_owner_id}).`
 :`${r.seller_name} was already owned by actor ${r.actor_id}; nothing changed.`);
if(!r.enabled) console.log('Note: this business is disabled, so it will not appear on the consent screen.');
