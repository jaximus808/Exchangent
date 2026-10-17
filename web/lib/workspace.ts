export type BuyRequest={id:string;requirements:string;status:string;currency:string;created_at:string;title?:string;budget_cents?:number};
export type Offer={id:string;seller_id:string;version:number;delivery_cents:number;tax_cents:number;expires_at:string;is_current:boolean;items:{inventory_id:string;quantity:number;unit_cents:number}[];total_cents:number;name?:string;tagline?:string;delivery?:string;description?:string;fee_cents?:number;recommended?:boolean};
export type OrderStatus={reservation_id:string;status:string;total_cents:number;currency:string;order:{id:string;status:string;total_cents:number;currency:string;created_at:string}|null};
export const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2}).format(cents/100);
export const demoRequest:BuyRequest={id:'preview-office',title:'A better home office',requirements:'An oak desk and ergonomic chair for my home office. Keep the desk under 48 inches wide, and deliver both this weekend.',budget_cents:40000,status:'awaiting_payment',currency:'usd',created_at:'2026-10-17T18:30:00Z'};
export const demoOffers:Offer[]=[
 {id:'preview-northline',seller_id:'northline',version:3,delivery_cents:2500,tax_cents:0,expires_at:'2026-10-19T23:59:00Z',is_current:true,items:[{inventory_id:'desk',quantity:1,unit_cents:20000},{inventory_id:'chair',quantity:1,unit_cents:14000}],total_cents:37595,fee_cents:1095,name:'Northline Office',tagline:'Pre-owned, thoughtfully restored',delivery:'Sunday, October 18',description:'48″ oak desk + ergonomic chair',recommended:true},
 {id:'preview-form',seller_id:'form',version:2,delivery_cents:1900,tax_cents:0,expires_at:'2026-10-19T23:59:00Z',is_current:true,items:[{inventory_id:'desk',quantity:1,unit_cents:22000},{inventory_id:'chair',quantity:1,unit_cents:14000}],total_cents:39037,fee_cents:1137,name:'Form & Field',tagline:'Furniture with a second chapter',delivery:'Sunday, October 18',description:'47″ birch desk + task chair'},
 {id:'preview-studio',seller_id:'studio',version:1,delivery_cents:0,tax_cents:0,expires_at:'2026-10-19T23:59:00Z',is_current:true,items:[{inventory_id:'desk',quantity:1,unit_cents:24000},{inventory_id:'chair',quantity:1,unit_cents:15000}],total_cents:40170,fee_cents:1170,name:'The Office Edit',tagline:'Everyday essentials, well made',delivery:'Monday, October 19',description:'48″ desk + mesh office chair'},
];
export async function api<T>(path:string,init:RequestInit={}):Promise<T> {
 const response=await fetch(`/api/commerce/${path}`,{...init,headers:{'content-type':'application/json',...init.headers},cache:'no-store'});
 const result=await response.json();
 if(!response.ok) throw new Error(response.status===401?'Your session has expired. Please sign in again.':result.error?.message??'Something went wrong. Please try again.');
 return result.data;
}
