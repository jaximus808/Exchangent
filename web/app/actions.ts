'use server';
import {cookies} from 'next/headers';
import {createAuthActions} from '@insforge/sdk/ssr';
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function requestSignIn(email:string) {
 if(!emailPattern.test(email)||email.length>254) return {error:'Enter a valid email address.'};
 try {
  const auth=createAuthActions({cookies:await cookies()});
  const {error}=await auth.signInWithOtp({email});
  return error?{error:'We couldn’t send your code. Please try again.'}:{sent:true};
 } catch {return {error:'Sign-in is temporarily unavailable. Please try again.'};}
}
export async function verifySignIn(email:string,otp:string) {
 if(!emailPattern.test(email)||!/^\d{6}$/.test(otp)) return {error:'Enter the six-digit code from your email.'};
 try {
  const auth=createAuthActions({cookies:await cookies()});
  const {data,error}=await auth.verifyOtp({email,otp});
  return error||!data?.user?{error:'That code is invalid or expired. Request a new one.'}:{ok:true};
 } catch {return {error:'We couldn’t verify your code. Please try again.'};}
}
export async function endSession() {
 const auth=createAuthActions({cookies:await cookies()});
 const {error}=await auth.signOut();
 return {ok:!error};
}
