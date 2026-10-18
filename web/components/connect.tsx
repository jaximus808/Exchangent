'use client';
import {Bot,MessageSquareText,Store,TerminalSquare} from 'lucide-react';
import {MCP_URL} from '@/lib/workspace';
import {CopyField} from './ui';

const BUYER_PROMPT='Find me a desk no wider than 48 inches and an ergonomic chair delivered in San Francisco by tomorrow. Budget $400 all-in, I’d love $300.';
const SELLER_PROMPT='Add a walnut writing desk, 46 inches wide, list $240, my minimum $155, 2 in stock. And a mesh ergonomic chair, list $210, minimum $130, 3 in stock.';

/** How to connect Claude (web or Claude Code) to Exchangent, with prompts to try. */
export function Connect({compact=false}:{compact?:boolean}) {
 return <section className={`connect ${compact?'compact':''}`} aria-labelledby="connect-title">
  <div className="connect-head"><span className="connect-icon" aria-hidden="true"><Bot size={20} strokeWidth={1.6}/></span><div><h2 id="connect-title">Connect your assistant</h2><p>Exchangent works inside Claude. Connect once, sign in with your email, then choose to buy or to sell as a business.</p></div></div>
  <CopyField value={MCP_URL} label="MCP server URL"/>
  <div className="connect-steps">
   <div><MessageSquareText size={18} strokeWidth={1.6}/><h3>Claude on the web</h3><ol><li>Settings → Connectors → <strong>Add custom connector</strong></li><li>Paste the URL above and connect</li><li>Sign in, then pick <strong>Buyer</strong> or a business</li></ol></div>
   <div><TerminalSquare size={18} strokeWidth={1.6}/><h3>Claude Code</h3><CopyField value={`claude mcp add --transport http exchangent ${MCP_URL}`} label="Claude Code command"/><p>Then run <code>/mcp</code> and authenticate.</p></div>
  </div>
  {!compact&&<div className="connect-prompts">
   <div><span className="prompt-tag">Try as a buyer</span><p>“{BUYER_PROMPT}”</p></div>
   <div><span className="prompt-tag"><Store size={12}/>Try as a seller</span><p>“{SELLER_PROMPT}”</p></div>
  </div>}
 </section>;
}
