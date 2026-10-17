import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Load agents/.env.local into process.env (existing env vars win). */
export function loadEnvFile(file = path.join(AGENTS_DIR, ".env.local")) {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Strip a trailing slash and an optional trailing /api/v1 so callers can append /api/v1/... */
export function normalizeBackendUrl(url) {
  return String(url).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/**
 * Principals file written by backend/scripts/seed-negotiation.mjs:
 * { backend_url, buyer: { actor_id, token }, sellers: [{ seller_id, name, token }], worker: { token } }
 */
export function readPrincipals(file) {
  if (!existsSync(file)) {
    throw new Error(
      `Principals file not found: ${file}. Run the backend demo seed (backend/scripts/seed-negotiation.mjs) ` +
        `or set PRINCIPALS_FILE in agents/.env.local.`,
    );
  }
  const p = JSON.parse(readFileSync(file, "utf8"));
  if (!p?.worker?.token) throw new Error(`${file}: missing worker.token`);
  if (!p?.buyer?.token) throw new Error(`${file}: missing buyer.token`);
  if (!Array.isArray(p.sellers)) throw new Error(`${file}: missing sellers[]`);
  return p;
}

export function loadConfig(env = process.env) {
  const principalsFile = path.resolve(AGENTS_DIR, env.PRINCIPALS_FILE || "../backend/.demo-principals.json");
  const principals = readPrincipals(principalsFile);
  const transport = (env.TRANSPORT || "local").toLowerCase();
  const brain = (env.BRAIN || "mock").toLowerCase();
  if (!["local", "inkbox"].includes(transport)) throw new Error(`TRANSPORT must be local or inkbox, got ${transport}`);
  if (!["mock", "claude"].includes(brain)) throw new Error(`BRAIN must be mock or claude, got ${brain}`);
  if (transport === "inkbox" && !env.INKBOX_API_KEY) {
    throw new Error("TRANSPORT=inkbox needs INKBOX_API_KEY (an admin-scoped key) in agents/.env.local");
  }
  return {
    transport,
    brain,
    backendUrl: normalizeBackendUrl(env.BACKEND_URL || principals.backend_url || "http://127.0.0.1:8787"),
    mcpUrl: env.MCP_URL || "http://127.0.0.1:3100/mcp",
    pollMs: Number(env.POLL_MS || 1000),
    principalsFile,
    principals,
    stateDir: path.resolve(AGENTS_DIR, env.STATE_DIR || ".state"),
    inkbox: {
      apiKey: env.INKBOX_API_KEY,
      baseUrl: env.INKBOX_BASE_URL || undefined,
      a2aBaseUrl: (env.INKBOX_A2A_BASE_URL || "https://inkbox.ai").replace(/\/+$/, ""),
      identityCap: Number(env.INKBOX_IDENTITY_CAP || 3),
      handlePrefix: env.INKBOX_HANDLE_PREFIX || "exchangent",
    },
    claude: {
      bin: env.CLAUDE_BIN || "claude",
      model: env.CLAUDE_MODEL || undefined,
      timeoutMs: Number(env.CLAUDE_TIMEOUT_MS || 180000),
    },
  };
}
