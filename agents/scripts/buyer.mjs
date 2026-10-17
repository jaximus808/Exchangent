// Plays the human buyer against the MCP server, for test runs without a chat client.
//   node scripts/buyer.mjs create                  -> create_buy_order (desk <=48in + ergonomic chair, $400 budget)
//   node scripts/buyer.mjs status   <request_id>   -> get_buy_order
//   node scripts/buyer.mjs offers   <request_id>   -> list_offers
//   node scripts/buyer.mjs reserve  <offer_id>     -> reserve_offer
//   node scripts/buyer.mjs checkout <reservation_id> -> get_checkout_link
// Env: MCP_URL (default http://127.0.0.1:3100/mcp), BUYER_TOKEN or PRINCIPALS_FILE (default ../backend/.demo-principals.json)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mcpUrl = process.env.MCP_URL ?? 'http://127.0.0.1:3100/mcp';
const [cmd, arg] = process.argv.slice(2);
const calls = {
  create: () => ['create_buy_order', {
    title: 'Desk + ergonomic chair', budget_cents: 40000, target_cents: 30000,
    requirements: { region: 'san_francisco', deliver_by: '2026-10-18',
      items: [{ category: 'desk', max_width_in: 48 }, { category: 'chair', ergonomic: true }] },
  }],
  status: () => ['get_buy_order', { request_id: arg }],
  offers: () => ['list_offers', { request_id: arg }],
  reserve: () => ['reserve_offer', { offer_id: arg }],
  checkout: () => ['get_checkout_link', { reservation_id: arg }],
};
if (!calls[cmd] || (cmd !== 'create' && !arg)) {
  console.error('usage: node scripts/buyer.mjs create | status <request_id> | offers <request_id> | reserve <offer_id> | checkout <reservation_id>');
  process.exit(2);
}

const token = process.env.BUYER_TOKEN ??
  JSON.parse(readFileSync(resolve(process.env.PRINCIPALS_FILE ?? '../backend/.demo-principals.json'), 'utf8')).buyer.token;

const client = new Client({ name: 'exchangent-buyer-cli', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));
const [name, args] = calls[cmd]();
const result = await client.callTool({ name, arguments: args });
console.log(JSON.stringify(result.structuredContent ?? JSON.parse(result.content[0].text), null, 2));
await client.close();
