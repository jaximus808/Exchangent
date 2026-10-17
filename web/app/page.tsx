import {cookies} from 'next/headers';
import {createServerClient} from '@insforge/sdk/ssr';
import {Dashboard} from '@/components/dashboard';
export const dynamic='force-dynamic';
export default async function Page() {
 let user:{id:string;email:string}|null=null;
 if(process.env.NEXT_PUBLIC_INSFORGE_URL&&process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY) {
  try {
   const client=createServerClient({cookies:await cookies()});
   const {data}=await client.auth.getCurrentUser();
   if(data?.user) user={id:data.user.id,email:data.user.email};
  } catch { /* Signed-out workspace preview remains available. */ }
 }
 return <Dashboard user={user}/>;
}
