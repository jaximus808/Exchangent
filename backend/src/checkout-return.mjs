// A checkout redirect is navigation, never evidence that payment succeeded.
export function checkoutReturn(res,path) {
 const paused=path==='/cancel';
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"});
 res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${paused?'Checkout paused':'Return to your conversation'} · Exchangent</title><style>
 body{margin:0;background:#f7f8f5;color:#252823;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{max-width:480px;margin:24px;padding:36px;border:1px solid #e3e6df;border-radius:12px;background:#fff}header{font-size:20px;font-weight:600;letter-spacing:-.7px}h1{font-size:28px;line-height:1.2;letter-spacing:-.7px;margin:30px 0 16px}p{color:#62685f}small{display:block;border-top:1px solid #e3e6df;padding-top:18px;margin-top:24px;color:#62685f}
 </style><main><header>⇄ exchangent.</header><h1>${paused?'Checkout paused.':'Return to your conversation.'}</h1><p>${paused?'You can resume checkout from your Exchangent card while your reservation is active.':'Your Exchangent card will show confirmation once Stripe payment has been verified.'}</p><p>Switch back to ChatGPT or Claude and ask: <strong>“Check my Exchangent order.”</strong></p><small>Stripe sandbox · no real money charged. This page does not confirm payment or cancel a reservation.</small></main></html>`);
}
