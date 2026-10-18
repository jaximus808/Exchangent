'use client';
import {useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {Check,Copy,Package,X} from 'lucide-react';

export function Brand({small=false}:{small?:boolean}) {
 return <span className={`brand ${small?'brand-small':''}`}><span className="brand-symbol" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 8h14m-4-4 4 4-4 4M19 16H5m4-4-4 4 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/></svg></span>{!small&&<span>exchangent<span className="brand-period">.</span></span>}</span>;
}
export function Status({children,tone='neutral'}:{children:React.ReactNode;tone?:'neutral'|'live'|'done'|'muted'}) {return <span className={`status-pill tone-${tone}`}><span className="status-dot"/>{children}</span>;}
export function Empty({title,children,action,icon}:{title:string;children:React.ReactNode;action?:React.ReactNode;icon?:React.ReactNode}) {return <div className="empty-state">{icon??<Package size={30} strokeWidth={1.2}/>}<h3>{title}</h3><p>{children}</p>{action}</div>;}
export function WorkspaceDialog({open,onClose,title,description,children}:{open:boolean;onClose:()=>void;title:string;description:string;children:React.ReactNode}) {
 return <Dialog.Root open={open} onOpenChange={v=>!v&&onClose()}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="modal-content"><div className="modal-top"><div><Dialog.Title>{title}</Dialog.Title><Dialog.Description>{description}</Dialog.Description></div><Dialog.Close className="icon-button" aria-label="Close dialog"><X size={19}/></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}
/** An on/off switch with a visible label; `busy` disables it while a change is saving. */
export function Toggle({checked,onChange,label,busy}:{checked:boolean;onChange:(v:boolean)=>void;label:string;busy?:boolean}) {
 return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`toggle ${checked?'on':''}`} disabled={busy} onClick={()=>onChange(!checked)}><span className="toggle-knob"/></button>;
}
export function CopyField({value,label}:{value:string;label:string}) {
 const[copied,setCopied]=useState(false);
 return <div className="copy-field"><code>{value}</code><button type="button" className="button secondary compact" aria-label={`Copy ${label}`} onClick={()=>{void navigator.clipboard?.writeText(value).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1600);}).catch(()=>{});}}>{copied?<Check size={14}/>:<Copy size={14}/>}{copied?'Copied':'Copy'}</button></div>;
}
export const initials=(name:string)=>name.split(/\s+/).filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'?';
