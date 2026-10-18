import { MCPServer } from "mcp-use";
import { authMode, createOAuthProvider } from "./src/auth.ts";
import { registerTools } from "./src/tools.ts";

// EXCHANGENT_AUTH=bearer (default): forward the caller's Authorization header.
// EXCHANGENT_AUTH=oauth: this server becomes an OAuth authorization server for MCP
// clients (mcp-use oauthProxy) in front of Exchangent's own OAuth server; see src/auth.ts.
const mode = authMode();

const server = new MCPServer({
  name: "exchangent",
  title: "Exchangent",
  version: "0.1.0",
  description: "Buyer and seller negotiation tools for the Exchangent agent marketplace.",
  // `mcp-use start` and server.listen() honour PORT first, then this value.
  port: 3100,
  instructions: [
    "Exchangent lets buyer agents and seller agents negotiate furniture deals; the backend enforces every rule.",
    mode === "oauth"
      ? "The account the human authorized when connecting (their buyer account or one of their businesses) decides your role; call whoami to check it."
      : "Your bearer token decides your role; call whoami to check it.",
    "Buyers: create_buy_order, get_buy_order, list_offers, counter_offer, decline_seller, reserve_offer, get_checkout_link, get_reservation_status.",
    "Sellers: list_my_requests, get_negotiation, get_inventory, make_offer, decline_request; owners also get_business, update_business, upsert_inventory_item.",
    "Anyone signed in as a buyer can open a business with register_business, then reconnect and choose it.",
    "All money inputs are integer US cents (*_cents). Always re-read state (get_negotiation / get_buy_order) and pass the session version as expected_version.",
    "Every result has status (ok|error) and next: follow next. Payment is only ever approved by the human in Stripe Checkout.",
  ].join("\n"),
  // The typed config only allows `oauth` on MCPServer<TUser>; tools stay typed as
  // MCPServer<never> (so the views' typed hooks are unchanged) and read ctx.auth defensively.
  ...((mode === "oauth" ? { oauth: createOAuthProvider() } : {}) as {}),
});

export const {whoami, create_buy_order, get_buy_order, list_offers, counter_offer, decline_seller, reserve_offer, get_checkout_link, get_reservation_status, list_my_requests, get_negotiation, get_inventory, make_offer, decline_request, register_business, get_business, update_business, upsert_inventory_item}=registerTools(server);

export default server;
