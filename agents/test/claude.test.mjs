// BRAIN=claude: command construction only. No real `claude -p` turn is run (it would spend the subscription).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildClaudeInvocation, createClaudeBrain, turnPrompt } from "../src/brains/claude.mjs";
import { buyerAgent, sellerAgent } from "../src/agents.mjs";

process.env.LOG_SILENT ??= "1";

const seller = sellerAgent({ seller_id: "s-acme", name: "Acme Desks", token: "tok-acme-secret" });
const buyer = buyerAgent({ actor_id: "b1", token: "tok-buyer-secret" });
const counterEvent = { id: "e1", kind: "counter.created", payload: { session_id: "sess-1", counter_id: "c-1", total_cents: 31337 } };
const offerEvent = { id: "e2", kind: "offer.created", payload: { session_id: "sess-1", request_id: "req-1", offer_id: "o-1", total_cents: 31337 } };

const flagValue = (args, flag) => args[args.indexOf(flag) + 1];

test("seller invocation: flags, MCP config with bearer token, persona, no numbers in the prompt", () => {
  const stateDir = "/tmp/x-state";
  const inv = buildClaudeInvocation({ agent: seller, event: counterEvent, mcpUrl: "http://127.0.0.1:3100/mcp", stateDir, bin: "/Users/jaxon/.local/bin/claude" });
  assert.equal(inv.cmd, "/Users/jaxon/.local/bin/claude");
  assert.equal(inv.cwd, path.join(stateDir, "claude", "seller_s-acme"));
  assert.equal(inv.args[0], "-p");
  assert.equal(inv.args[1], turnPrompt(seller, counterEvent), "prompt is positional, before any variadic flag");
  assert.equal(flagValue(inv.args, "--mcp-config"), path.join(inv.cwd, "mcp.json"));
  assert.ok(inv.args.includes("--strict-mcp-config"));
  assert.equal(flagValue(inv.args, "--allowedTools"), "mcp__exchangent__*");
  assert.equal(flagValue(inv.args, "--output-format"), "json");
  assert.equal(flagValue(inv.args, "--permission-mode"), "dontAsk");
  assert.ok(!inv.args.includes("--disallowedTools"));
  assert.match(flagValue(inv.args, "--append-system-prompt"), /Sell within your floors/);

  const mcp = JSON.parse(inv.files[path.join(inv.cwd, "mcp.json")]);
  assert.deepEqual(mcp, { mcpServers: { exchangent: { type: "http", url: "http://127.0.0.1:3100/mcp", headers: { Authorization: "Bearer tok-acme-secret" } } } });
  assert.match(inv.files[path.join(inv.cwd, "CLAUDE.md")], /make_offer/);
  assert.match(inv.files[path.join(inv.cwd, "CLAUDE.md")], /decline_request/);

  const prompt = inv.args[1];
  assert.ok(!prompt.includes("31337") && !prompt.includes("313.37"), "message numbers never reach the model");
  assert.ok(!inv.args.join(" ").includes("tok-acme-secret"), "token only in the 0600 config file, not argv");
  assert.match(prompt, /get_negotiation/);
});

test("buyer invocation: persona hides budget, reservation tools disallowed, --model passthrough", () => {
  const inv = buildClaudeInvocation({ agent: buyer, event: offerEvent, mcpUrl: "http://m/mcp", stateDir: "/tmp/s", model: "sonnet" });
  const disallowIdx = inv.args.indexOf("--disallowedTools");
  assert.deepEqual(inv.args.slice(disallowIdx + 1, disallowIdx + 4), [
    "mcp__exchangent__reserve_offer",
    "mcp__exchangent__get_checkout_link",
    "mcp__exchangent__create_buy_order",
  ]);
  assert.equal(flagValue(inv.args, "--model"), "sonnet");
  const persona = inv.files[path.join(inv.cwd, "CLAUDE.md")];
  assert.match(persona, /Never reveal the budget/);
  assert.match(persona, /target_cents/);
  assert.match(inv.args[1], /get_buy_order for request req-1/);
  assert.ok(!inv.args[1].includes("31337"));
});

test("createClaudeBrain writes owner-only files and parses --output-format json (spawn faked)", async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agents-claude-"));
  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", JSON.stringify({ type: "result", is_error: false, result: "Countered.\nMade offer o-9 at $340.", num_turns: 4, total_cost_usd: 0.01 }));
      child.emit("close", 0);
    });
    return child;
  };
  const brain = createClaudeBrain({ mcpUrl: "http://m/mcp", stateDir, bin: "claude", spawnImpl: fakeSpawn });
  const out = await brain.turn(seller, counterEvent);
  assert.equal(out.action, "claude");
  assert.equal(out.summary, "Made offer o-9 at $340.");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.cwd, path.join(stateDir, "claude", "seller_s-acme"));
  for (const f of ["CLAUDE.md", "mcp.json"]) {
    const p = path.join(spawned[0].opts.cwd, f);
    assert.ok(existsSync(p));
    assert.equal(statSync(p).mode & 0o777, 0o600);
  }
  assert.match(readFileSync(path.join(spawned[0].opts.cwd, "mcp.json"), "utf8"), /Bearer tok-acme-secret/);
});

const CLAUDE_BIN = "/Users/jaxon/.local/bin/claude";
test("installed claude CLI still accepts every flag we pass (reads --help only; no turn is run)", { skip: !existsSync(CLAUDE_BIN) && "claude CLI not installed" }, () => {
  const help = execFileSync(CLAUDE_BIN, ["--help"], { encoding: "utf8" });
  for (const flag of ["--print", "--mcp-config", "--strict-mcp-config", "--allowedTools", "--disallowedTools", "--permission-mode", "--output-format", "--no-session-persistence", "--append-system-prompt", "--model"]) {
    assert.ok(help.includes(flag), `claude --help lists ${flag}`);
  }
  assert.match(help, /dontAsk/);
  assert.match(help, /"json"/);
});
