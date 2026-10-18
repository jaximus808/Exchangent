import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface BuyerPrincipal {
  actor_id: string;
  token: string;
  /**
   * "buyer_agent" (backend/scripts/agent-tokens.ts): the platform buyer agent, negotiating every order whose
   * buyer delegated negotiation. "buyer" (the demo seed): one buyer's own token. Defaults to "buyer".
   */
  scope?: "buyer" | "buyer_agent";
}

export interface SellerPrincipal {
  seller_id: string;
  name: string;
  token: string;
}

/** Contents of the principals file (see readPrincipals). */
export interface Principals {
  backend_url?: string;
  buyer: BuyerPrincipal;
  sellers: SellerPrincipal[];
  worker: { token: string };
}

export type TransportName = "local" | "inkbox";
export type BrainName = "mock" | "claude";

/** TRANSPORT=inkbox settings. Every field is optional: InkboxTransport has a default for each. */
export interface InkboxConfig {
  apiKey?: string;
  baseUrl?: string;
  a2aBaseUrl?: string;
  identityCap?: number;
  handlePrefix?: string;
  /** INKBOX_LOCAL_SELLERS: seller names or IDs that always use in-process delivery (no identity). */
  localSellers?: string[];
}

/** BRAIN=claude settings. Every field is optional: the Claude brain has a default for each. */
export interface ClaudeConfig {
  bin?: string;
  model?: string;
  timeoutMs?: number;
}

export interface Config {
  transport: TransportName;
  brain: BrainName;
  backendUrl: string;
  mcpUrl: string;
  pollMs: number;
  /** SKIP_BACKLOG=1: ack events created before the runner started without delivering them. */
  skipBacklog: boolean;
  principalsFile: string;
  principals: Principals;
  stateDir: string;
  inkbox: InkboxConfig;
  claude: ClaudeConfig;
}

/** Property read on an unknown JSON value; undefined unless `o` is a non-null object. */
function field(o: unknown, key: string): unknown {
  return o !== null && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
}

/** Load agents/.env.local into process.env (existing env vars win). */
export function loadEnvFile(file: string = path.join(AGENTS_DIR, ".env.local")): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Strip a trailing slash and an optional trailing /api/v1 so callers can append /api/v1/... */
export function normalizeBackendUrl(url: unknown): string {
  return String(url).replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

/**
 * Principals file written by backend/scripts/seed-negotiation.ts:
 * { backend_url, buyer: { actor_id, token }, sellers: [{ seller_id, name, token }], worker: { token } }
 */
export function readPrincipals(file: string): Principals {
  if (!existsSync(file)) {
    throw new Error(
      `Principals file not found: ${file}. Run the backend demo seed (backend/scripts/seed-negotiation.ts) ` +
        `or set PRINCIPALS_FILE in agents/.env.local.`,
    );
  }
  const p: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!field(field(p, "worker"), "token")) throw new Error(`${file}: missing worker.token`);
  if (!field(field(p, "buyer"), "token")) throw new Error(`${file}: missing buyer.token`);
  if (!Array.isArray(field(p, "sellers"))) throw new Error(`${file}: missing sellers[]`);
  // Only the fields checked above are validated; the rest follows the seed script's format.
  return p as Principals;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const principalsFile = path.resolve(AGENTS_DIR, env.PRINCIPALS_FILE || "../backend/.demo-principals.json");
  const principals = readPrincipals(principalsFile);
  const transport = (env.TRANSPORT || "local").toLowerCase();
  const brain = (env.BRAIN || "mock").toLowerCase();
  if (!isTransportName(transport)) throw new Error(`TRANSPORT must be local or inkbox, got ${transport}`);
  if (!isBrainName(brain)) throw new Error(`BRAIN must be mock or claude, got ${brain}`);
  if (transport === "inkbox" && !env.INKBOX_API_KEY) {
    throw new Error("TRANSPORT=inkbox needs INKBOX_API_KEY (an admin-scoped key) in agents/.env.local");
  }
  return {
    transport,
    brain,
    backendUrl: normalizeBackendUrl(env.BACKEND_URL || principals.backend_url || "http://127.0.0.1:8787"),
    mcpUrl: env.MCP_URL || "http://127.0.0.1:3100/mcp",
    pollMs: Number(env.POLL_MS || 1000),
    skipBacklog: ["1", "true", "yes"].includes((env.SKIP_BACKLOG || "").toLowerCase()),
    principalsFile,
    principals,
    stateDir: path.resolve(AGENTS_DIR, env.STATE_DIR || ".state"),
    inkbox: {
      apiKey: env.INKBOX_API_KEY,
      baseUrl: env.INKBOX_BASE_URL || undefined,
      a2aBaseUrl: (env.INKBOX_A2A_BASE_URL || "https://inkbox.ai").replace(/\/+$/, ""),
      identityCap: Number(env.INKBOX_IDENTITY_CAP || 3),
      handlePrefix: env.INKBOX_HANDLE_PREFIX || "exchangent",
      localSellers: (env.INKBOX_LOCAL_SELLERS || "").split(",").map((x) => x.trim()).filter(Boolean),
    },
    claude: {
      bin: env.CLAUDE_BIN || "claude",
      model: env.CLAUDE_MODEL || undefined,
      timeoutMs: Number(env.CLAUDE_TIMEOUT_MS || 180000),
    },
  };
}

function isTransportName(s: string): s is TransportName {
  return ["local", "inkbox"].includes(s);
}

function isBrainName(s: string): s is BrainName {
  return ["mock", "claude"].includes(s);
}
