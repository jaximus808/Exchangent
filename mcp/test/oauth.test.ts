/**
 * OAuth mode (EXCHANGENT_AUTH=oauth): mcp-use oauthProxy in front of a fake
 * Exchangent OAuth server, on localhost with in-memory storage.
 *
 * Covers discovery (401 + WWW-Authenticate, protected-resource and
 * authorization-server metadata) and one full sign-in driven by the MCP SDK
 * client: dynamic client registration -> consent page -> fake Exchangent
 * authorize -> proxy callback -> token -> tool calls that forward the
 * upstream `exc_…` connector token (never the proxy's own token) to a fake backend.
 *
 * Runs in its own process (node --test isolates files), so setting
 * EXCHANGENT_AUTH here does not affect the bearer-mode tests.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { IDS, startFakeBackend, type FakeBackend } from "./fake-backend.ts";
import { startFakeExchangentOAuth, type FakeExchangentOAuth } from "./fake-exchangent-oauth.ts";
import { fetchExchangentUser, mapExchangentUser, oauthStorage } from "../src/auth.ts";

let backend: FakeBackend;
let upstream: FakeExchangentOAuth;
let mcpUrl: string;
let origin: string;
let closeServer: () => Promise<void>;
const clients: Client[] = [];

before(async () => {
  backend = await startFakeBackend();
  upstream = await startFakeExchangentOAuth();
  process.env.EXCHANGENT_AUTH = "oauth";
  process.env.EXCHANGENT_API_URL = backend.url;
  process.env.EXCHANGENT_OAUTH_AUTHORIZE_URL = upstream.authorizeUrl;
  process.env.EXCHANGENT_OAUTH_TOKEN_URL = upstream.tokenUrl;
  process.env.MCP_USE_OAUTH_SECRET = "test-only-secret-0123456789abcdef0123456789";
  process.env.EXCHANGENT_OAUTH_CLIENT_ID = upstream.clientId;
  process.env.EXCHANGENT_OAUTH_CLIENT_SECRET = upstream.clientSecret;
  // Proves the dev fallback is ignored in oauth mode.
  process.env.EXCHANGENT_TOKEN = "env-fallback-token-must-not-be-used";
  for (const k of ["MCP_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
  const { default: server } = await import(new URL("../.mcp-use/build/index.js", import.meta.url).href);
  const { url } = await server.listen(0);
  mcpUrl = url;
  origin = new URL(url).origin;
  closeServer = () => server.close();
});

after(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await closeServer?.();
  await backend?.close();
  await upstream?.close();
});

const initializeBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } },
});
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** Minimal cookie-carrying "browser" that follows the sign-in redirects by hand. */
class Browser {
  jar = new Map<string, string>();
  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  }
}

/** In-memory OAuth client (like Claude Code) whose "browser" signs in and approves consent. */
class TestOAuthClient implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  code?: Promise<string>;
  steps: { url: string; status: number }[] = [];
  get redirectUrl() {
    return "http://127.0.0.1:1/callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Exchangent oauth test", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  redirectToAuthorization(authorizationUrl: URL) {
    this.code = this.browse(authorizationUrl.href);
  }
  private async browse(start: string): Promise<string> {
    const browser = new Browser();
    // 1. Proxy /authorize renders the consent page.
    let res = await browser.go(start);
    this.steps.push({ url: start, status: res.status });
    assert.equal(res.status, 200, "consent page");
    const html = await res.text();
    const action = /<form[^>]*action="([^"]+)"/i.exec(html)?.[1]?.replace(/&amp;/g, "&");
    assert.ok(action, "consent form action");
    // 2. Approve consent -> redirect to the Exchangent authorize endpoint.
    let next = new URL(action, start).href;
    res = await browser.go(next, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "decision=allow" });
    this.steps.push({ url: next, status: res.status });
    // 3. Follow redirects (Exchangent authorize -> proxy callback -> client redirect_uri).
    for (let i = 0; i < 6; i++) {
      const location = res.headers.get("location");
      assert.ok(res.status >= 300 && res.status < 400 && location, `redirect expected at ${next} (got ${res.status}: ${await res.text().catch(() => "")})`);
      next = new URL(location, next).href;
      if (next.startsWith(this.redirectUrl)) {
        const code = new URL(next).searchParams.get("code");
        assert.ok(code, "authorization code returned to the MCP client");
        return code;
      }
      res = await browser.go(next);
      this.steps.push({ url: next, status: res.status });
    }
    throw new Error("sign-in did not return to the client");
  }
}

async function signIn(provider: TestOAuthClient): Promise<Client> {
  const first = new Client({ name: "exchangent-oauth-test", version: "0.0.0" });
  await assert.rejects(first.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider })), UnauthorizedError);
  const code = await provider.code!;
  const finisher = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  await finisher.finishAuth(code);
  const client = new Client({ name: "exchangent-oauth-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider }));
  clients.push(client);
  return client;
}

describe("oauth mode: discovery", () => {
  test("an unauthenticated MCP request gets 401 with WWW-Authenticate pointing at protected-resource metadata", async () => {
    const res = await fetch(mcpUrl, { method: "POST", headers: mcpHeaders, body: initializeBody });
    assert.equal(res.status, 401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer /);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    assert.ok(metadataUrl, challenge);
    assert.equal(new URL(metadataUrl).pathname, "/.well-known/oauth-protected-resource/mcp");
  });

  test("a caller's own bearer token (e.g. a 64-hex role token) is rejected, not forwarded", async () => {
    backend.requests.length = 0;
    const res = await fetch(mcpUrl, { method: "POST", headers: { ...mcpHeaders, authorization: `Bearer ${"a".repeat(64)}` }, body: initializeBody });
    assert.equal(res.status, 401);
    assert.equal(backend.requests.length, 0);
  });

  test("protected-resource and authorization-server metadata name this server's /mcp/oauth endpoints", async () => {
    const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(new URL(prm.resource).pathname, "/mcp");
    assert.ok(Array.isArray(prm.authorization_servers) && prm.authorization_servers.length === 1, JSON.stringify(prm));
    const issuer: string = prm.authorization_servers[0];
    const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer.replace(/\/$/, ""), issuer.replace(/\/$/, ""));
    assert.equal(new URL(as.authorization_endpoint).pathname, "/mcp/oauth/authorize");
    assert.equal(new URL(as.token_endpoint).pathname, "/mcp/oauth/token");
    assert.equal(new URL(as.registration_endpoint).pathname, "/mcp/oauth/register");
    assert.ok(as.code_challenge_methods_supported.includes("S256"));
  });
});

describe("oauth mode: full sign-in through a fake Exchangent OAuth server", () => {
  test("buyer sign-in: tools forward the exc_ connector token; whoami shows the buyer; 401 asks to reconnect", async () => {
    upstream.nextAccessToken = "exc_buyer_test_token_1";
    const provider = new TestOAuthClient();
    const client = await signIn(provider);

    // What the proxy sent upstream (the contract the web/ OAuth server implements).
    const authz = upstream.authorizeRequests.at(-1)!;
    assert.equal(authz.response_type, "code");
    assert.equal(authz.client_id, upstream.clientId);
    assert.equal(authz.redirect_uri, `${origin}/mcp/oauth/callback`);
    assert.equal(authz.scope, "buyer seller");
    assert.equal(authz.code_challenge_method, "S256");
    assert.ok(authz.state && authz.code_challenge);
    const tok = upstream.tokenRequests.at(-1)!;
    assert.equal(tok.grant_type, "authorization_code");
    assert.equal(tok.client_secret, upstream.clientSecret, "client_secret_post");
    assert.equal(tok.redirect_uri, `${origin}/mcp/oauth/callback`);
    assert.ok(tok.code_verifier);
    // The proxy resolved the delegation via GET /me at sign-in.
    assert.ok(backend.requests.some((r) => r.path === "/api/v1/me" && r.headers.authorization === "Bearer exc_buyer_test_token_1"));
    // The MCP client holds only the proxy's own token.
    assert.match(provider.saved!.access_token, /^mcp_at_/);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 14);

    const who = (await client.callTool({ name: "whoami", arguments: {} })).structuredContent as Record<string, any>;
    assert.equal(who.status, "ok");
    assert.equal(who.auth_mode, "oauth");
    assert.equal(who.acting_as, "buyer");
    assert.equal(who.kind, "connector");
    assert.equal(who.scope, "buyer");
    assert.equal(who.seller_id, null);
    assert.ok(!/exc_|exr_|mcp_at_/.test(JSON.stringify(who)), "no tokens in whoami output");

    backend.requests.length = 0;
    const order = (await client.callTool({ name: "get_buy_order", arguments: { request_id: IDS.request } })).structuredContent as Record<string, any>;
    assert.equal(order.status, "ok");
    assert.equal(backend.requests.length, 1);
    assert.equal(backend.requests[0].headers.authorization, "Bearer exc_buyer_test_token_1");

    // Delegation revoked on the Exchangent side -> tool error telling the human to reconnect.
    backend.revoke("exc_buyer_test_token_1");
    const { result, sc } = await (async () => {
      const r = await client.callTool({ name: "get_buy_order", arguments: { request_id: IDS.request } });
      return { result: r, sc: r.structuredContent as Record<string, any> };
    })();
    assert.equal(result.isError, true);
    assert.equal(sc.error.code, "unauthorized");
    assert.match(sc.next, /reconnect/);
    assert.ok(!/exc_|exr_|mcp_at_/.test(JSON.stringify(result)), "no tokens in tool output");
  });

  test("seller sign-in: whoami reports the business; seller tools forward its token", async () => {
    upstream.nextAccessToken = "exc_seller_test_token_2";
    const client = await signIn(new TestOAuthClient());
    const who = (await client.callTool({ name: "whoami", arguments: {} })).structuredContent as Record<string, any>;
    assert.equal(who.acting_as, "seller");
    assert.equal(who.seller_id, IDS.seller);
    assert.match(who.next, /list_my_requests/);
    backend.requests.length = 0;
    const inv = (await client.callTool({ name: "get_inventory", arguments: {} })).structuredContent as Record<string, any>;
    assert.equal(inv.status, "ok");
    assert.equal(backend.requests[0].headers.authorization, "Bearer exc_seller_test_token_2");
  });
});

describe("oauth helpers", () => {
  test("fetchExchangentUser keys buyer and seller authorizations separately", async () => {
    const buyer = await fetchExchangentUser("exc_buyer_x");
    const seller = await fetchExchangentUser("exc_seller_x");
    assert.equal(buyer.subject, "a0000000-0000-4000-8000-00000000000a:buyer");
    assert.equal(seller.subject, `a0000000-0000-4000-8000-00000000000a:seller:${IDS.seller}`);
    assert.equal(mapExchangentUser(buyer).acting_as, "buyer");
    assert.equal(mapExchangentUser(seller).acting_as, "seller");
    await assert.rejects(fetchExchangentUser("revoked-or-unknown", async () => new Response("{}", { status: 401 })), /HTTP 401/);
  });

  test("oauth mode refuses to start without the authorize URL and client credentials", async () => {
    const { createOAuthProvider } = await import("../src/auth.ts");
    assert.throws(() => createOAuthProvider({}), /EXCHANGENT_OAUTH_AUTHORIZE_URL.*EXCHANGENT_OAUTH_CLIENT_ID.*EXCHANGENT_OAUTH_CLIENT_SECRET/);
  });

  test("memory storage is refused for a public MCP_URL without Upstash", () => {
    assert.throws(() => oauthStorage({ MCP_URL: "https://mcp.example.com" }), /UPSTASH_REDIS_REST_URL/);
    assert.doesNotThrow(() => oauthStorage({ MCP_URL: "http://localhost:3100" }));
    assert.doesNotThrow(() => oauthStorage({ MCP_URL: "https://mcp.example.com", UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" }));
  });
});
