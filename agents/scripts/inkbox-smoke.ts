// Live Inkbox smoke test: one A2A round trip between the demo's real agent identities, through the real
// tunnels and signed webhooks, using the same InkboxTransport the runner uses.
//
//   cd agents && npm run inkbox:smoke            (node --env-file-if-exists=.env.local scripts/inkbox-smoke.ts)
//   npm run inkbox:smoke -- --seller "Bay Desk Co"
//
// It provisions (or reuses, from agents/.state/identities.json) the buyer identity and ONE seller identity, with
// the same agent ids and handles the runner uses, so it never spends an extra identity on the free plan. Then:
//   1. session.opened   buyer -> seller   (synthetic ids, nothing touches the backend)
//   2. offer.created    seller -> buyer
// and waits until each one reaches the recipient's onMessage handler. Do not run it while `npm start` is
// running with TRANSPORT=inkbox: two processes on one tunnel take it over from each other.
// It never prints API keys or signing keys.

import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { buyerAgent, sellerAgent } from "../src/agents.ts";
import type { Agent } from "../src/agents.ts";
import type { WorkerEvent } from "../src/backend.ts";
import type { TransportMessage } from "../src/transport/index.ts";
import { InkboxTransport } from "../src/transport/inkbox.ts";

const TIMEOUT_MS = 60_000;

function fail(message: string): never {
  console.error(`inkbox smoke: ${message}`);
  process.exit(2);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (!process.env.INKBOX_API_KEY) {
  fail(
    "INKBOX_API_KEY is not set. Create an admin-scoped key in the Inkbox Console (https://inkbox.ai/console) and put\n" +
      "  INKBOX_API_KEY=<key>\n" +
      "in agents/.env.local, then run `npm run inkbox:smoke` again from agents/.",
  );
}

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  const message = (err as Error).message;
  if (/Principals file not found/.test(message)) {
    fail(
      `${message}\nSeed the demo first (the backend seed writes backend/.demo-principals.json), or point PRINCIPALS_FILE at it.`,
    );
  }
  fail(message);
}

const sellerName = argValue("--seller") || process.env.SMOKE_SELLER || "Bay Desk Co";
const sellerPrincipal = config.principals.sellers.find((s) => s.name.trim().toLowerCase() === sellerName.trim().toLowerCase());
if (!sellerPrincipal) {
  fail(`no seller named "${sellerName}" in ${config.principalsFile} (have: ${config.principals.sellers.map((s) => s.name).join(", ")})`);
}

const buyer = buyerAgent(config.principals.buyer);
const seller = sellerAgent(sellerPrincipal);

const transport = new InkboxTransport({
  ...config.inkbox,
  apiKey: process.env.INKBOX_API_KEY,
  stateDir: config.stateDir,
  // The runner registers seller handles with the backend; the smoke test only logs (see the finally below).
  backend: {
    registerSellerAgent: async (sellerId: string, agentHandle: string) => {
      console.log(`inkbox smoke: (stub) would register seller ${sellerId} -> @${agentHandle} with the backend`);
      return null;
    },
  },
});

const sellerWasRegistered = Boolean(transport.identityFor(seller.id)?.registered);
const known = Object.values(transport.state.data.identities).map((r) => r.handle);
console.log(`inkbox smoke: state ${config.stateDir} (identities already provisioned: ${known.length ? known.join(", ") : "none"})`);

/** Resolves with the message once `agent` receives the event `eventId`. */
const waiters = new Map<string, (m: TransportMessage) => void>();
function arrival(eventId: string): Promise<TransportMessage> {
  return new Promise((resolve) => waiters.set(eventId, resolve));
}
for (const agent of [buyer, seller]) {
  transport.onMessage(agent, (m) => {
    console.log(`inkbox smoke: ${agent.id} received ${m.kind} ${m.id} from ${m.from}`);
    waiters.get(m.id)?.(m);
  });
}

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

interface StepResult {
  name: string;
  from: string;
  to: string;
  ok: boolean;
  sendMs?: number;
  deliverMs?: number;
  error?: string;
}

const sessionId = randomUUID();
const requestId = randomUUID();

async function step(name: string, from: Agent, to: Agent, event: WorkerEvent): Promise<StepResult> {
  const result: StepResult = { name, from: from.id, to: to.id, ok: false };
  const arrived = arrival(event.id);
  const t0 = Date.now();
  try {
    await transport.send(from, to, event);
  } catch (err) {
    result.error = `send failed: ${(err as Error).message}`;
    return result;
  }
  result.sendMs = Date.now() - t0;
  const got = await Promise.race([arrived, timeout(TIMEOUT_MS)]);
  if (!got) {
    result.error = `not delivered to ${to.id} within ${TIMEOUT_MS / 1000}s`;
    await printDeliveries(to);
    return result;
  }
  result.deliverMs = Date.now() - t0;
  const okPayload = got.from === from.id && got.kind === event.kind && got.payload.session_id === sessionId;
  result.ok = okPayload;
  if (!okPayload) result.error = `unexpected message ${JSON.stringify({ from: got.from, kind: got.kind, session: got.payload.session_id })}`;
  return result;
}

/** On a timeout, show what Inkbox's delivery log says for the recipient's subscription (no payloads). */
async function printDeliveries(to: Agent): Promise<void> {
  const rec = transport.identityFor(to.id);
  if (!rec?.subscription_id || !transport.admin) return;
  try {
    const rows = await transport.admin.webhooks.deliveries.list({ subscriptionId: rec.subscription_id, limit: 5 });
    if (!rows.length) console.log(`inkbox smoke: no webhook deliveries logged yet for @${rec.handle}`);
    for (const d of rows) {
      console.log(
        `inkbox smoke: delivery ${d.eventType} -> ${d.url} status=${d.responseStatus ?? "none"} ` +
          `${d.durationMs ?? "?"}ms${d.errorDetail ? ` error=${d.errorDetail}` : ""} at ${d.createdAt.toISOString()}`,
      );
    }
  } catch (err) {
    console.log(`inkbox smoke: could not read the delivery log: ${(err as Error).message}`);
  }
}

const results: StepResult[] = [];
let exitCode = 1;
const started = Date.now();
try {
  const t0 = Date.now();
  await transport.ensureIdentity(buyer);
  await transport.ensureIdentity(seller);
  console.log(`inkbox smoke: identities ready and tunnels started in ${Date.now() - t0}ms`);

  const opened: WorkerEvent = {
    id: randomUUID(),
    kind: "session.opened",
    created_at: new Date().toISOString(),
    payload: { session_id: sessionId, request_id: requestId },
    route: { to_role: "seller", seller_id: seller.sellerId, request_id: requestId },
  };
  results.push(await step("session.opened buyer -> seller", buyer, seller, opened));

  if (results[0].ok) {
    const offer: WorkerEvent = {
      id: randomUUID(),
      kind: "offer.created",
      created_at: new Date().toISOString(),
      payload: { session_id: sessionId, request_id: requestId, offer_id: randomUUID(), total_cents: 12345, note: "inkbox smoke test" },
      route: { to_role: "buyer", seller_id: seller.sellerId, request_id: requestId },
    };
    results.push(await step("offer.created seller -> buyer", seller, buyer, offer));
  }
  exitCode = results.length === 2 && results.every((r) => r.ok) ? 0 : 1;
} catch (err) {
  const status = (err as { statusCode?: number }).statusCode;
  const hint =
    status === 401 ? " (INKBOX_API_KEY was rejected: use an admin-scoped key from the Inkbox Console)" :
    status === 403 ? " (forbidden: the key must be admin-scoped, and identities must be claimed)" : "";
  console.error(`inkbox smoke: setup failed: ${(err as Error).message}${hint}`);
} finally {
  // Give the background a2aReply (task -> completed) a moment, then shut the tunnels down.
  await timeout(1500);
  await transport.close();
  // Leave the state as the runner expects it: the backend registration was only stubbed here, and the
  // synthetic session's A2A context is not needed.
  const rec = transport.identityFor(seller.id);
  if (rec && !sellerWasRegistered) delete rec.registered;
  delete transport.state.data.contexts[sessionId];
  transport.state.save();
}

console.log("");
console.log("Inkbox smoke test");
for (const agent of [buyer, seller]) {
  const rec = transport.identityFor(agent.id);
  console.log(`  ${agent.id.padEnd(48)} ${rec ? `@${rec.handle}  https://${rec.public_host}` : "(no identity)"}`);
}
for (const r of results) {
  const timing = r.deliverMs !== undefined ? `sent in ${r.sendMs}ms, delivered in ${r.deliverMs}ms` : r.sendMs !== undefined ? `sent in ${r.sendMs}ms` : "";
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(34)} ${timing}${r.error ? `  (${r.error})` : ""}`);
}
console.log(`  ${exitCode === 0 ? "PASS" : "FAIL"}  total ${Date.now() - started}ms`);
if (exitCode !== 0) {
  console.log(
    "  The A2A tasks (and the webhook delivery log) can be inspected in the Inkbox Console (https://inkbox.ai/console);\n" +
      "  rerunning is safe: identities, keys and subscriptions are reused from agents/.state.",
  );
}
process.exit(exitCode);
