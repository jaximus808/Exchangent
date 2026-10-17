// MCP client for the Exchangent MCP server (mcp/, served at MCP_URL), authenticated as one agent.
// Uses the official @modelcontextprotocol/sdk client over Streamable HTTP with the agent's bearer token.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "./log.mjs";

const log = logger("mcp");

/**
 * Normalize a tools/call result. The contract says tools return `{ status, ...data, next }` and report
 * errors as tool results. Prefer structuredContent, else parse the first JSON text block.
 */
export function parseToolResult(result) {
  let out = null;
  if (result?.structuredContent && typeof result.structuredContent === "object") out = { ...result.structuredContent };
  if (!out) {
    const text = (result?.content || []).find((c) => c.type === "text")?.text;
    if (text) {
      try { out = JSON.parse(text); } catch { out = { text }; }
    } else {
      out = {};
    }
  }
  if (out && typeof out === "object" && "data" in out && out.data && typeof out.data === "object" && !Array.isArray(out.data) && !out.status) {
    out = { ...out.data, status: "ok" }; // tolerate a raw backend envelope
  }
  if (result?.isError && !out.status) out.status = "error";
  if (out.error && !out.status) out.status = "error";
  return out;
}

export function isToolError(r) {
  return r?.status === "error" || r?.status === "rejected" || Boolean(r?.error);
}

export function toolErrorCode(r) {
  return r?.code || r?.error?.code || r?.error_code || null;
}

export class McpToolClient {
  constructor({ url, token, agentId }) {
    this.url = url;
    this.token = token;
    this.agentId = agentId;
    this.client = null;
  }

  async connect() {
    const client = new Client({ name: `exchangent-agent-${this.agentId}`, version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    await client.connect(transport);
    this.client = client;
    return this;
  }

  async call(name, args = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.client) await this.connect();
        const res = await this.client.callTool({ name, arguments: args });
        const parsed = parseToolResult(res);
        log.info(`${name}`, { agent: this.agentId, status: parsed.status, code: toolErrorCode(parsed) || undefined });
        return parsed;
      } catch (err) {
        // Session expired or server restarted: reconnect once.
        await this.close();
        if (attempt === 1) throw err;
      }
    }
  }

  async close() {
    const c = this.client;
    this.client = null;
    if (c) await c.close().catch(() => {});
  }
}
