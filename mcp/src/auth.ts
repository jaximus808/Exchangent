/**
 * How MCP callers authenticate, chosen by `EXCHANGENT_AUTH`:
 *
 * - `bearer` (default): the caller sends `Authorization: Bearer <Exchangent token>`
 *   on the MCP HTTP request and the adapter forwards it to the backend
 *   (`EXCHANGENT_TOKEN` is a dev-only fallback). Used by the autonomous agent
 *   runner and the existing Manufact deployment.
 * - `oauth`: the server is an OAuth authorization server for MCP clients
 *   (mcp-use `oauthProxy`) in front of Exchangent's own OAuth server (web/
 *   authorize page + backend token endpoint, doc/oauth-contract.md). The human
 *   signs in to Exchangent in the browser and picks their buyer account or one
 *   of their businesses; the backend issues a connector token (`exc_…`) which
 *   the proxy keeps server-side and the adapter forwards to the backend. MCP clients only ever hold the proxy's own `mcp_at_…` token,
 *   which is never forwarded.
 */
import { isBuilding } from "mcp-use";
import { memoryStorage, oauthProxy, upstream, type OAuthProxyStorage, type UpstreamUser } from "mcp-use/oauth";
import { upstashStorage } from "mcp-use/oauth/storage";
import { apiBaseUrl } from "./adapter.ts";

export type AuthMode = "bearer" | "oauth";

/** The auth mode, read from `EXCHANGENT_AUTH` (default `bearer`). */
export function authMode(): AuthMode {
  const raw = (process.env.EXCHANGENT_AUTH ?? "").trim().toLowerCase();
  if (raw === "" || raw === "bearer") return "bearer";
  if (raw === "oauth") return "oauth";
  throw new Error(`EXCHANGENT_AUTH must be "bearer" or "oauth" (got ${JSON.stringify(process.env.EXCHANGENT_AUTH)}).`);
}

/** Backend token endpoint (doc/oauth-contract.md). The authorize page lives in the separate web/ app and has no default. */
export const DEFAULT_OAUTH_TOKEN_URL = "https://exchangent.vercel.app/api/v1/oauth/token";
/** Requested from Exchangent on every sign-in; the consent screen narrows it to the one account the human picks. */
export const UPSTREAM_SCOPES = ["buyer", "seller"] as const;
/** Upstream id: appears in mcp-use storage keys (`up:exchangent:<subject>`) and `ctx.auth.payload.provider`. */
export const UPSTREAM_ID = "exchangent";

/** `ctx.auth.user` in oauth mode, built from the backend's `GET /me` for the connector token. */
export interface ExchangentUser {
  /** Stable id of this authorization: `<actor_id>:<scope>[:<seller_id>]`. */
  id: string;
  actor_id: string;
  /** Principal kind reported by the backend: "connector" for connector tokens. */
  kind: string | null;
  /** The role the human granted on the consent screen: "buyer" or "seller". */
  scope: string | null;
  /** Business this authorization acts for, when the human picked one of their businesses. */
  seller_id: string | null;
  /** Exchangent OAuth client the token was issued to (this MCP server's client). */
  client_id: string | null;
  /** "seller" when the grant is for a business, otherwise "buyer". The backend still enforces everything. */
  acting_as: "buyer" | "seller";
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Subject used by mcp-use to key the stored upstream tokens (`up:exchangent:<subject>`):
 * `actor_id:scope[:seller_id]`, so a person's buyer grant and each business grant stay separate.
 */
export function subjectFor(me: { actor_id: string; scope: string | null; seller_id: string | null }): string {
  return [me.actor_id, me.scope ?? (me.seller_id ? "seller" : "buyer"), ...(me.seller_id ? [me.seller_id] : [])].join(":");
}

/**
 * `fetchUser` for the Exchangent upstream: resolve the freshly issued connector
 * token (`exc_…`) to its principal via `GET {EXCHANGENT_API_URL}/me`, which returns
 * `{ data: { kind: "connector", scope, actor_id, seller_id, client_id } }`.
 */
export async function fetchExchangentUser(accessToken: string, fetchImpl: typeof globalThis.fetch = fetch): Promise<UpstreamUser> {
  const response = await fetchImpl(`${apiBaseUrl()}/me`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Exchangent GET /me returned HTTP ${response.status}`);
  const payload = (await response.json().catch(() => undefined)) as { data?: Record<string, unknown> } | undefined;
  const data = payload?.data;
  const actor_id = str(data?.actor_id);
  if (!data || !actor_id) throw new Error("Exchangent GET /me returned no actor_id");
  const profile = {
    actor_id,
    kind: str(data.kind),
    scope: str(data.scope),
    seller_id: str(data.seller_id),
    client_id: str(data.client_id),
  };
  return { subject: subjectFor(profile), profile };
}

/** `mapUser`: shape the stored upstream user into `ctx.auth.user`. */
export function mapExchangentUser(user: UpstreamUser): ExchangentUser {
  const p = user.profile;
  const scope = str(p.scope);
  const seller_id = str(p.seller_id);
  return {
    id: user.subject,
    actor_id: str(p.actor_id) ?? user.subject,
    kind: str(p.kind),
    scope,
    seller_id,
    client_id: str(p.client_id),
    acting_as: scope === "seller" || (scope === null && seller_id) ? "seller" : "buyer",
  };
}

function isLocalhostUrl(value: string | undefined): boolean {
  if (!value) return true; // no MCP_URL: mcp-use derives a localhost resource from listen(), or refuses a public bind
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** Upstash when configured; process memory only for a localhost resource (local dev and tests). */
export function oauthStorage(env: NodeJS.ProcessEnv = process.env): OAuthProxyStorage {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) return upstashStorage({ url, token });
  if (isBuilding() || isLocalhostUrl(env.MCP_URL)) return memoryStorage();
  throw new Error(
    "EXCHANGENT_AUTH=oauth on a public MCP_URL needs shared storage: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
  );
}

/**
 * Client ID metadata documents of assistants we know, copied from their public URLs (2026-10-18). claude.ai's
 * bot protection can answer a cloud server with 403 while serving everyone else, and the proxy then refuses
 * the sign-in ("Unknown app"). A live 200 always wins; this copy is used only when the live fetch fails.
 */
export const PINNED_CLIENT_METADATA: Readonly<Record<string, object>> = {
  "https://claude.ai/oauth/claude-code-client-metadata": {
    client_id: "https://claude.ai/oauth/claude-code-client-metadata", client_name: "Claude Code", client_uri: "https://claude.ai",
    redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  },
  "https://claude.ai/oauth/mcp-oauth-client-metadata": {
    client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata", client_name: "Claude", client_uri: "https://claude.ai",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code"],
    token_endpoint_auth_method: "none",
  },
};
/** Hosts whose metadata documents may be fetched, plus `EXCHANGENT_CIMD_HOSTS` (comma-separated). */
export const CIMD_HOSTS = ["claude.ai", "chatgpt.com"] as const;

/**
 * The proxy's `fetch` (upstream token and `/me` calls, and client metadata documents). A custom fetch turns
 * off mcp-use's private-address check, so this one only reaches the Exchangent API and token hosts and the
 * listed assistant hosts, and falls back to {@link PINNED_CLIENT_METADATA} when a known document can't be loaded.
 */
export function proxyFetch(env: NodeJS.ProcessEnv = process.env, base: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const extra = (env.EXCHANGENT_CIMD_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const allowed = () => new Set([
    new URL(env.EXCHANGENT_OAUTH_TOKEN_URL?.trim() || DEFAULT_OAUTH_TOKEN_URL).host,
    new URL(apiBaseUrl()).host, ...CIMD_HOSTS, ...extra,
  ]);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!allowed().has(url.host.toLowerCase())) throw new Error(`host ${url.host} is not allowed by the Exchangent proxy`);
    const pinned = PINNED_CLIENT_METADATA[url.href];
    if (!pinned) return base(input, init);
    try {
      const response = await base(input, init);
      if (response.status === 200) return response;
      console.warn(`[exchangent] ${url.href} returned HTTP ${response.status}; using the pinned client metadata`);
    } catch (error) {
      console.warn(`[exchangent] ${url.href} failed (${(error as Error).message}); using the pinned client metadata`);
    }
    return Response.json(pinned);
  };
}

/** Build the `oauth` option for `MCPServer` in oauth mode. Throws with the missing env var names. */
export function createOAuthProvider(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.EXCHANGENT_OAUTH_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.EXCHANGENT_OAUTH_CLIENT_SECRET?.trim() ?? "";
  // Placeholder only while `mcp-use build` imports the entry; never used to serve.
  const authorizationEndpoint = env.EXCHANGENT_OAUTH_AUTHORIZE_URL?.trim() || (isBuilding() ? "https://build.invalid/oauth/authorize" : "");
  if (!isBuilding()) {
    const missing = [
      !authorizationEndpoint && "EXCHANGENT_OAUTH_AUTHORIZE_URL (the web app's /oauth/authorize page)",
      !clientId && "EXCHANGENT_OAUTH_CLIENT_ID",
      !clientSecret && "EXCHANGENT_OAUTH_CLIENT_SECRET",
    ].filter(Boolean);
    if (missing.length) throw new Error(`EXCHANGENT_AUTH=oauth requires ${missing.join(", ")}.`);
  }
  const secret = env.MCP_USE_OAUTH_SECRET?.trim() || undefined;
  return oauthProxy<ExchangentUser>({
    upstream: upstream({
      id: UPSTREAM_ID,
      name: "Exchangent",
      authorizationEndpoint,
      tokenEndpoint: env.EXCHANGENT_OAUTH_TOKEN_URL?.trim() || DEFAULT_OAUTH_TOKEN_URL,
      clientId,
      clientSecret,
      scopes: [...UPSTREAM_SCOPES],
      pkce: true,
      fetchUser: (tokens, fetchImpl) => fetchExchangentUser(tokens.accessToken, fetchImpl),
    }),
    storage: oauthStorage(env),
    // Required (>= 32 chars) outside a localhost listen(); mcp-use validates it on mount.
    ...(secret ? { secret } : {}),
    mapUser: mapExchangentUser,
    fetch: proxyFetch(env),
  });
}
