import type {ConvSession} from './conversation.ts';
import {priceHistory} from './price-history.ts';

/** X is the seller's offer sequence, not synchronized rounds or elapsed time. */
export function offerRace(sessions:ConvSession[],width=720) {
 const series=sessions.map(session=>({session,offers:priceHistory(session)}));
 let maximum=0,rounds=1;
 for(const s of series){rounds=Math.max(rounds,s.offers.length);for(const o of s.offers)maximum=Math.max(maximum,o.cents);}
 const raw=Math.max(1,maximum)/4,power=10**Math.floor(Math.log10(raw)),fraction=raw/power;
 const step=Math.max(1,(fraction<=1?1:fraction<=2?2:fraction<=5?5:10)*power);
 const ceiling=Math.max(step,Math.ceil(maximum/step)*step);
 const left=54,right=Math.max(left+20,width-24),top=22,bottom=200;
 const x=(index:number)=>left+(right-left)*index/Math.max(1,rounds-1);
 const y=(cents:number)=>bottom-(bottom-top)*cents/ceiling;
 const ticks=Array.from({length:Math.round(ceiling/step)+1},(_,i)=>({cents:i*step,y:y(i*step)}));
 return {rounds,ceiling,left,right,top,bottom,ticks,
  series:series.map(s=>({...s,points:s.offers.map((o,i)=>({...o,x:x(i),y:y(o.cents),round:i+1}))}))};
}
