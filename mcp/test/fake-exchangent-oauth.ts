/**
 * Fake Exchangent OAuth server (the upstream behind mcp-use's oauthProxy), used
 * only by the oauth-mode tests. It implements doc/oauth-contract.md as the proxy
 * uses it (see mcp/README.md "Upstream OAuth contract"): an authorize endpoint that
 * immediately "approves" and redirects back with a code, and a token endpoint
 * that checks client_secret_post credentials and PKCE before issuing an
 * `exc_…` connector token. Every request is recorded for assertions.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeExchangentOAuth {
  origin: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Query params of each authorize request. */
  authorizeRequests: Record<string, string>[];
  /** Form bodies of each token request. */
  tokenRequests: Record<string, string>[];
  /** Access token the next authorization code will be exchanged for. */
  nextAccessToken: string;
  close(): Promise<void>;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startFakeExchangentOAuth(): Promise<FakeExchangentOAuth> {
  const codes = new Map<string, { challenge?: string; redirectUri: string; accessToken: string; scope: string }>();
  let counter = 0;
  const state: FakeExchangentOAuth = {
    origin: "",
    authorizeUrl: "",
    tokenUrl: "",
    clientId: "exchangent-mcp-test-client",
    clientSecret: "test-client-secret-not-real",
    authorizeRequests: [],
    tokenRequests: [],
    nextAccessToken: "exc_buyer_test_token_1",
    close: async () => {},
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      const q = Object.fromEntries(url.searchParams);
      state.authorizeRequests.push(q);
      if (q.response_type !== "code" || q.client_id !== state.clientId || !q.redirect_uri || !q.state) {
        return json(400, { error: "invalid_request" });
      }
      // A real server signs the human in and shows the buyer/seller consent here.
      const code = `code_${++counter}`;
      const granted = state.nextAccessToken.includes("seller") ? "seller" : "buyer";
      codes.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri, accessToken: state.nextAccessToken, scope: granted });
      const back = new URL(q.redirect_uri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.state);
      res.writeHead(302, { Location: back.href });
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/v1/oauth/token") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      state.tokenRequests.push(form);
      if (!(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return json(400, { error: "invalid_request" });
      if (form.client_id !== state.clientId || form.client_secret !== state.clientSecret) return json(401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        const entry = codes.get(form.code);
        codes.delete(form.code);
        if (!entry || entry.redirectUri !== form.redirect_uri) return json(400, { error: "invalid_grant" });
        if (entry.challenge) {
          const expected = b64url(createHash("sha256").update(form.code_verifier ?? "").digest());
          if (expected !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        }
        return json(200, { access_token: entry.accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: `exr_${counter}`, scope: entry.scope });
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.origin = `http://127.0.0.1:${port}`;
  state.authorizeUrl = `${state.origin}/oauth/authorize`;
  state.tokenUrl = `${state.origin}/api/v1/oauth/token`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
