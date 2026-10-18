'use client';
import {useCallback,useEffect,useState} from 'react';
import {Bot,Loader2,LockKeyhole,MessageSquareText,Plus,Store,Truck,UserRound} from 'lucide-react';
import {currentOffer,type ConvSession} from '@/lib/conversation';
import {api,ApiError,dollarsToCents,errorText,money,type Business,type InventoryItem} from '@/lib/workspace';
import {Thread} from './thread';
import {Empty,Status,Toggle,WorkspaceDialog,initials} from './ui';

type SellerSession=ConvSession&{request_title?:string|null;request?:{title?:string|null}|null};
const sessionTitle=(s:SellerSession)=>s.title||s.request_title||s.request?.title||'Buy request';
function normalizeSessions(raw:unknown,business:Business):SellerSession[] {
 const list=Array.isArray(raw)?raw:raw&&typeof raw==='object'&&Array.isArray((raw as {sessions?:unknown}).sessions)?(raw as {sessions:unknown[]}).sessions:[];
 return (list as SellerSession[]).map(s=>({...s,seller_name:s.seller_name??business.name,seller_agent:s.seller_agent??business.delegate_negotiation,messages:Array.isArray(s.messages)?s.messages:[]}));
}
const attrText=(item:InventoryItem)=>Object.entries(item.attributes??{}).map(([k,v])=>v===true?k.replaceAll('_',' '):k.endsWith('_in')?`${v}″ ${k.slice(0,-3)}`:`${k.replaceAll('_',' ')} ${String(v)}`).join(' · ');

export function CreateBusinessForm({onCreated}:{onCreated:(b:Business)=>void}) {
 const[name,setName]=useState('');const[fee,setFee]=useState('15');const[days,setDays]=useState('1');
 const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 return <form className="stack-form" onSubmit={async e=>{e.preventDefault();setError('');
  const delivery_cents=dollarsToCents(fee||'0'),delivery_days=Number(days||'2');
  if(name.trim().length<2||name.trim().length>80) return setError('Business names are 2 to 80 characters.');
  if(!Number.isInteger(delivery_cents)||delivery_cents<0||delivery_cents>100000||!Number.isInteger(delivery_days)||delivery_days<0||delivery_days>30) return setError('Delivery is $0–$1,000 and 0–30 days.');
  setBusy(true);
  try {onCreated(await api<Business>('businesses',{method:'POST',body:JSON.stringify({name:name.trim(),delivery_cents,delivery_days})}));}
  catch(err){setError(errorText(err,'The business couldn’t be created.'));} finally{setBusy(false);}
 }}>
  <label>Business name<input value={name} onChange={e=>setName(e.target.value)} placeholder="Alex Woodworks" maxLength={80} required autoFocus/></label>
  <div className="form-grid"><label>Delivery fee<div className="input-with-prefix"><span>$</span><input type="number" min="0" max="1000" step=".01" value={fee} onChange={e=>setFee(e.target.value)}/></div></label><label>Delivery days<input type="number" min="0" max="30" step="1" value={days} onChange={e=>setDays(e.target.value)}/></label></div>
  <p className="field-help">You can sell in San Francisco today. Your seller agent negotiates for you once you add stock.</p>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Store size={16}/>}Create business</button>
 </form>;
}

function AddItemForm({business,onAdded}:{business:Business;onAdded:(item:InventoryItem)=>void}) {
 const[title,setTitle]=useState('');const[category,setCategory]=useState('desk');const[other,setOther]=useState('');
 const[width,setWidth]=useState('46');const[ergonomic,setErgonomic]=useState(true);
 const[list,setList]=useState('');const[floor,setFloor]=useState('');const[available,setAvailable]=useState('1');
 const[error,setError]=useState('');const[busy,setBusy]=useState(false);
 return <form className="stack-form" onSubmit={async e=>{e.preventDefault();setError('');
  const cat=category==='other'?other.trim().toLowerCase().replace(/\s+/g,'_'):category;
  const list_cents=dollarsToCents(list),floor_cents=dollarsToCents(floor),stock=Number(available);
  if(!title.trim()) return setError('Give the item a title.');
  if(!/^[a-z_]{2,40}$/.test(cat)) return setError('Categories are 2–40 letters, like “lamp” or “bookshelf”.');
  if(!Number.isInteger(list_cents)||list_cents<=0||!Number.isInteger(floor_cents)||floor_cents<=0) return setError('Enter a list price and a minimum price.');
  if(floor_cents>list_cents) return setError('Your minimum can’t be above the list price.');
  if(!Number.isInteger(stock)||stock<0) return setError('Stock is a whole number.');
  const attributes:Record<string,unknown>={};
  if(cat==='desk'&&width.trim()){const w=Number(width);if(!Number.isFinite(w)||w<=0)return setError('Enter the desk width in inches.');attributes.width_in=w;}
  if(cat==='chair') attributes.ergonomic=ergonomic;
  setBusy(true);
  try {onAdded(await api<InventoryItem>(`businesses/${business.seller_id}/inventory`,{method:'POST',body:JSON.stringify({title:title.trim(),category:cat,attributes,list_cents,floor_cents,available:stock})}));}
  catch(err){setError(errorText(err,'The item couldn’t be saved.'));} finally{setBusy(false);}
 }}>
  <label>Item<input value={title} onChange={e=>setTitle(e.target.value)} placeholder="Walnut writing desk" maxLength={200} required autoFocus/></label>
  <div className="form-grid"><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}><option value="desk">Desk</option><option value="chair">Chair</option><option value="other">Something else</option></select></label>
   {category==='desk'&&<label>Width (inches)<input type="number" min="1" step=".5" value={width} onChange={e=>setWidth(e.target.value)}/></label>}
   {category==='chair'&&<label className="check-label"><input type="checkbox" checked={ergonomic} onChange={e=>setErgonomic(e.target.checked)}/>Ergonomic</label>}
   {category==='other'&&<label>Category name<input value={other} onChange={e=>setOther(e.target.value)} placeholder="bookshelf" maxLength={40}/></label>}
  </div>
  <div className="form-grid three"><label>List price<div className="input-with-prefix"><span>$</span><input type="number" min="0.01" step=".01" value={list} onChange={e=>setList(e.target.value)} required/></div></label>
   <label>Your minimum<div className="input-with-prefix"><span>$</span><input type="number" min="0.01" step=".01" value={floor} onChange={e=>setFloor(e.target.value)} required/></div><span className="field-help"><LockKeyhole size={10}/> Private. Buyers never see it.</span></label>
   <label>In stock<input type="number" min="0" step="1" value={available} onChange={e=>setAvailable(e.target.value)} required/></label></div>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <button className="button primary full" disabled={busy}>{busy?<Loader2 size={16} className="spin"/>:<Plus size={16}/>}Add to {business.name}</button>
 </form>;
}

function BusinessPanel({business,onUpdated}:{business:Business;onUpdated:(b:Business)=>void}) {
 const[inventory,setInventory]=useState<InventoryItem[]|null|undefined>(business.inventory);
 const[sessions,setSessions]=useState<SellerSession[]|null>(null);
 const[toggling,setToggling]=useState(false);const[error,setError]=useState('');const[adding,setAdding]=useState(false);
 const[now,setNow]=useState(()=>Date.now());
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),5000);return()=>clearInterval(t);},[]);
 const load=useCallback(async()=>{
  if(document.visibilityState==='hidden') return;
  try {setSessions(normalizeSessions(await api<unknown>(`businesses/${business.seller_id}/sessions`),business));} catch {setSessions(s=>s??[]);}
  if(business.inventory) setInventory(business.inventory);
  else try {setInventory(await api<InventoryItem[]>(`businesses/${business.seller_id}/inventory`));} catch(e) {setInventory(e instanceof ApiError&&e.status===404?null:i=>i??null);}
 },[business]);
 useEffect(()=>{void load();const t=setInterval(load,5000);return()=>clearInterval(t);},[load]);
 async function toggle(on:boolean) {
  setToggling(true);setError('');
  try {onUpdated(await api<Business>(`businesses/${business.seller_id}`,{method:'PATCH',body:JSON.stringify({delegate_negotiation:on})}));}
  catch(e){setError(errorText(e,'That setting couldn’t be saved.'));} finally{setToggling(false);}
 }
 const open=(sessions??[]).filter(s=>s.status==='open');
 return <article className="business-panel">
  <header className="business-head"><span className="seller-badge" aria-hidden="true">{initials(business.name)}</span>
   <div className="business-title"><h2>{business.name}</h2><span>{business.agent_handle?<span className="mono">@{business.agent_handle}</span>:'Inkbox identity created on first negotiation'} · <Truck size={12}/>{business.delivery_cents?money(business.delivery_cents):'Free'} · {business.delivery_days} day{business.delivery_days===1?'':'s'}</span></div>
   <div className="agent-switch"><span>{business.delegate_negotiation?<><Bot size={14}/>Seller agent negotiates</>:<><UserRound size={14}/>You negotiate in chat</>}</span><Toggle checked={business.delegate_negotiation} onChange={v=>void toggle(v)} label="Let my seller agent negotiate" busy={toggling}/></div>
  </header>
  {error&&<p className="form-error" role="alert">{error}</p>}
  <div className="business-grid">
   <section className="inventory-section"><div className="section-heading"><h2>Inventory <span className="number-tag">{inventory?.length??0}</span></h2><button className="button secondary compact" onClick={()=>setAdding(true)}><Plus size={14}/>Add item</button></div>
    {inventory===undefined?<div className="skeleton"/>:inventory===null?<p className="muted small-copy">Inventory is managed from Claude: “show my inventory”.</p>:inventory.length===0?<Empty title="No stock yet.">Add what you sell with a list price and a private minimum. Your agent never goes below it.</Empty>:
     <div className="inventory-table" role="table" aria-label={`${business.name} inventory`}><div role="row" className="inv-row inv-head"><span role="columnheader">Item</span><span role="columnheader">List</span><span role="columnheader">Minimum</span><span role="columnheader">Stock</span></div>
      {inventory.map(i=><div role="row" className="inv-row" key={i.inventory_id}><span role="cell"><strong>{i.title}</strong><small>{[i.category,attrText(i)].filter(Boolean).join(' · ')}</small></span><span role="cell">{i.list_cents!=null?money(i.list_cents):'—'}</span><span role="cell" className="private"><LockKeyhole size={11}/>{money(i.floor_cents)}</span><span role="cell">{i.available}{i.sold?<small>{i.sold} sold</small>:null}</span></div>)}</div>}
   </section>
   <section className="negotiations-section"><div className="section-heading"><h2><MessageSquareText size={16}/>Negotiations <span className="number-tag">{open.length}</span></h2><Status tone={open.length?'live':'muted'}>{open.length?'Live':'Quiet'}</Status></div>
    {sessions===null?<div className="skeleton"/>:sessions.length===0?<p className="muted small-copy">Matching buy requests appear here, with every message between your agent and the buyer’s agent.</p>:
     <div className="conversation-list">{sessions.slice(0,8).map((s,i)=><details className="conversation-card" key={s.session_id} open={i===0}><summary><strong>{sessionTitle(s)}</strong><span>{currentOffer(s)?.total_cents!==undefined?money(currentOffer(s)!.total_cents!):s.status==='declined'?'Declined':'Your offer pending'}</span><span className="muted">{s.status==='open'?(s.turn==='seller'?'Your move':'Buyer’s move'):s.status}</span></summary><Thread session={s} conversation={null} perspective="seller" now={now}/></details>)}</div>}
   </section>
  </div>
  <WorkspaceDialog open={adding} onClose={()=>setAdding(false)} title="Add an item" description="List price is your opening ask. Your minimum stays private: buyers only ever see offers.">
   <AddItemForm business={business} onAdded={item=>{setInventory(list=>[...(list??[]).filter(i=>i.inventory_id!==item.inventory_id),item]);setAdding(false);}}/>
  </WorkspaceDialog>
 </article>;
}

export function Selling({businesses,loading,onChanged,onCreate}:{businesses:Business[];loading:boolean;onChanged:(b:Business)=>void;onCreate:()=>void}) {
 if(loading) return <div className="skeleton-wrap"><div className="skeleton large"/></div>;
 if(!businesses.length) return <Empty title="Sell with your own agent." icon={<Store size={30} strokeWidth={1.2}/>} action={<button className="button primary" onClick={onCreate}><Plus size={16}/>Create a business</button>}>Create a business, add stock with private minimums, and a seller agent negotiates with buyers’ agents for you.</Empty>;
 return <div className="stack-gap">{businesses.map(b=><BusinessPanel key={b.seller_id} business={b} onUpdated={onChanged}/>)}</div>;
}
