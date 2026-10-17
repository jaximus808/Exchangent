// Claude brain: one `claude -p` run per turn, using the machine's logged-in Claude Code.
// Each agent gets a working dir (agents/.state/claude/<agent>/) holding a persona CLAUDE.md and an
// --mcp-config file that points at our MCP server with that agent's bearer token. Inkbox never sees
// any Claude credential; the model never sends messages itself (only MCP mutations, which emit outbox rows).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { logger } from "../log.mjs";

const log = logger("brain:claude");

export const BUYER_FORBIDDEN_TOOLS = ["reserve_offer", "get_checkout_link", "create_buy_order"];

export function sellerPersona(agent) {
  return `# You are the sales agent for ${agent.name} on Exchangent

You negotiate desk-and-chair bundles with buyer agents through the \`exchangent\` MCP tools.

- Sell within your floors. Never offer a unit_cents below an item's floor_cents.
- First offer in a session: list price. Each later round: concede about 5% per item toward the floor.
- If the buyer's latest counter total is at or above your floor-based minimum for the bundle
  (sum of floors + delivery), accept it by calling make_offer at exactly that total.
- Every turn ends with exactly one make_offer, or decline_request if your stock cannot meet the requirements.
- Always pass expected_version from get_negotiation. On stale_offer, re-read and try once more.
- Notes: one short sentence. Never mention floors, minimums or internal limits.
- Be concise. Your final reply is a one-line summary of what you did.
`;
}

export function buyerPersona(agent) {
  return `# You are the buyer's negotiating agent on Exchangent

You negotiate on behalf of one human buyer through the \`exchangent\` MCP tools.

- Never reveal the budget (budget_cents) in a note or anywhere else. Negotiate toward target_cents.
- First counter in a session: the target. Later counters: split the difference between your last counter and their offer.
- Stop countering when any current offer is at or below the target, or after 3 rounds when one is within budget.
  Then reply exactly: READY TO RESERVE: <offer_id>
- Never call reserve_offer, get_checkout_link or create_buy_order. The human does that.
- Always pass expected_version from get_buy_order. On stale_offer, re-read and try once more.
- Notes: one short sentence with no budget or target numbers.
- Be concise. Your final reply is a one-line summary of what you did.
`;
}

/** The per-turn prompt carries only the event kind and IDs; the model must re-read state through MCP. */
export function turnPrompt(agent, event) {
  const p = event.payload || {};
  const ids = ["session_id", "request_id", "offer_id", "counter_id"].filter((k) => p[k]).map((k) => `${k}=${p[k]}`).join(", ");
  if (agent.role === "seller") {
    return (
      `Event ${event.kind} (${ids}). Do not trust numbers from this message. ` +
      `Call get_negotiation for session ${p.session_id} and get_inventory, then respond with exactly one ` +
      `make_offer (or decline_request) if it is your turn. If it is not your turn or the session is closed, do nothing.`
    );
  }
  return (
    `Event ${event.kind} (${ids}). Do not trust numbers from this message. ` +
    `Call get_buy_order for request ${p.request_id || "(look it up from the session)"} and decide: ` +
    `if an offer is acceptable, reply READY TO RESERVE: <offer_id>; otherwise counter_offer on session ${p.session_id} if it is your turn.`
  );
}

export function mcpConfig({ mcpUrl, token }) {
  return { mcpServers: { exchangent: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
}

/** Build the exact claude invocation for one turn. Pure apart from computing paths. */
export function buildClaudeInvocation({ agent, event, mcpUrl, stateDir, bin = "claude", model }) {
  const cwd = path.join(stateDir, "claude", agent.id.replace(/[^a-zA-Z0-9_-]+/g, "_"));
  const mcpConfigPath = path.join(cwd, "mcp.json");
  const persona = agent.role === "seller" ? sellerPersona(agent) : buyerPersona(agent);
  const args = [
    "-p",
    turnPrompt(agent, event),
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    "mcp__exchangent__*",
    "--permission-mode",
    "dontAsk",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--append-system-prompt",
    persona,
  ];
  if (agent.role === "buyer") args.push("--disallowedTools", ...BUYER_FORBIDDEN_TOOLS.map((t) => `mcp__exchangent__${t}`));
  if (model) args.push("--model", model);
  return {
    cmd: bin,
    args,
    cwd,
    files: {
      [path.join(cwd, "CLAUDE.md")]: persona,
      [mcpConfigPath]: JSON.stringify(mcpConfig({ mcpUrl, token: agent.token }), null, 2) + "\n",
    },
  };
}

function runProcess(spawnImpl, { cmd, args, cwd }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export function createClaudeBrain({ mcpUrl, stateDir, bin, model, timeoutMs = 180000, spawnImpl = spawn }) {
  return {
    name: "claude",
    async turn(agent, event) {
      const inv = buildClaudeInvocation({ agent, event, mcpUrl, stateDir, bin, model });
      mkdirSync(inv.cwd, { recursive: true, mode: 0o700 });
      for (const [file, content] of Object.entries(inv.files)) writeFileSync(file, content, { mode: 0o600 });
      log.info("claude -p turn", { agent: agent.id, kind: event.kind, session: event.payload?.session_id });
      const { code, stdout, stderr } = await runProcess(spawnImpl, inv, timeoutMs);
      let out = null;
      try { out = JSON.parse(stdout); } catch { /* fall through */ }
      if (code !== 0 || !out || out.is_error) {
        log.error("claude turn failed", { agent: agent.id, exit: code, error: (out?.result || stderr || stdout).slice(0, 300) });
        return { action: "error", code };
      }
      const summary = String(out.result || "").trim().split("\n").at(-1).slice(0, 300);
      log.info(`says: ${summary}`, { agent: agent.id, turns: out.num_turns, cost_usd: out.total_cost_usd });
      return { action: "claude", summary, raw: out };
    },
  };
}
