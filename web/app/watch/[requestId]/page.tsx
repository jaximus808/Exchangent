import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {createServerClient} from '@insforge/sdk/ssr';
import {Watch,WatchSignedOut,WatchInvalid} from '@/components/watch';

// Per-request: reads the session cookie.
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Live negotiation · Exchangent',robots:{index:false,follow:false}};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WatchPage({params}:{params:Promise<{requestId:string}>}) {
 const {requestId}=await params;
 if(!UUID.test(requestId)) return <WatchInvalid/>;
 let user:{id:string;email:string}|null=null;
 if(process.env.NEXT_PUBLIC_INSFORGE_URL&&process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY) {
  try {
   const {data}=await createServerClient({cookies:await cookies()}).auth.getCurrentUser();
   if(data?.user) user={id:data.user.id,email:data.user.email};
  } catch { /* Signed out: show sign-in, then come back here. */ }
 }
 if(!user) return <WatchSignedOut configured={Boolean(process.env.NEXT_PUBLIC_INSFORGE_URL&&process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY)}/>;
 return <Watch requestId={requestId.toLowerCase()} email={user.email}/>;
}
