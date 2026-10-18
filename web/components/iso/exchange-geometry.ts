// Anatomy projection/solids, MIT © 2026 Ryan. See ANATOMY-LICENSE.
// Figure: a buyer's trading desk and three seller counters. 77 solid parts.
// Base: plinths, feet, corner fixings. Structure: uprights, shelves, counter tops.
// Mechanism: offer-card trays and cards. Controls: terminals and key decks.
// Planar connection lines represent message routes, not physical pipes/cables.
import {iso,slabOf,depthOf,pathOf,type SolidPaths,type Projection,type Point3} from './iso-kit';
export const camera:Projection={origin:[340,220],scale:1};
export const buyer:Point3=[-100,100,0];
export const sellers:Point3[]=[[-100,-100,0],[10,-210,0],[120,-320,0]];
export type Part={paths:SolidPaths;kind:string;depth:number};
function station(point:Point3,isBuyer=false) {
 const[x,y]=point,parts:Part[]=[];
 const block=(dx:number,dy:number,w:number,d:number,z:number,h:number,kind='body')=>{const plan={x:x+dx,y:y+dy,w,d,r:1.5};parts.push({paths:slabOf(plan,z,h,camera,4,.5),kind,depth:depthOf([x+dx+w/2,y+dy+d/2,z+h/2],camera)});};
 block(-40,-28,80,56,-5,5,'base');

 for(const dx of [-32,25])for(const dy of [-21,15])block(dx,dy,7,6,0,5,'foot');
 block(-32,-21,6,42,5,25);block(26,-21,6,42,5,25);
 block(-27,-20,54,5,5,24,'back');
 block(-36,-24,72,48,30,4,'counter');block(-31,-20,2,2,34,.5,'fixing');
 block(-24,-8,25,19,34,2,'tray');
 block(-22,-6,21,15,36,1,'card');block(-21,-5,19,13,37.5,1,'card');
 block(9,-12,13,4,34,4,'terminal');block(7,-14,17,3,38,15,'screen');
 block(8,-14.5,15,.8,40,11,'display');
 block(8,-6,17,10,34,1,'keys');
 if(isBuyer){block(-26,8,26,8,34,1,'ledger');block(-24,10,14,1,35,0.5,'ink');block(-24,13,19,1,35,0.5,'ink');}
 else{block(-26,14,18,3,34,1,'label');block(-29,21,58,2,26,2,'trim');}
 return parts.sort((a,b)=>a.depth-b.depth);
}
export const buyerParts=station(buyer,true);
export const sellerParts=sellers.map(p=>station(p));
export const at=(p:Point3)=>iso(p,camera);
export const labels=sellers.map(p=>at([p[0],p[1],0]));
export const routes=sellers.map((p,i)=>pathOf([at([p[0],p[1]+30,0]),at([p[0],p[1]+48+i*6,0]),at([-100-i*12,p[1]+48+i*6,0]),at([-100-i*12,70,0]),at([-100,70,0])]));
