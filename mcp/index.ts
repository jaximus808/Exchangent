import { MCPServer } from "mcp-use";
import { registerTools } from "./src/tools.ts";

const server = new MCPServer({
  name: "exchangent",
  title: "Exchangent",
  version: "0.1.0",
  description: "Buyer and seller negotiation tools for the Exchangent agent marketplace.",
  // `mcp-use start` and server.listen() honour PORT first, then this value.
  port: 3100,
  instructions: [
    "Exchangent lets buyer agents and seller agents negotiate furniture deals; the backend enforces every rule.",
    "Your bearer token decides your role. Buyers: create_buy_order, get_buy_order, list_offers, counter_offer, decline_seller, reserve_offer, get_checkout_link, get_reservation_status.",
    "Sellers: list_my_requests, get_negotiation, get_inventory, make_offer, decline_request.",
    "All money inputs are integer US cents (*_cents). Always re-read state (get_negotiation / get_buy_order) and pass the session version as expected_version.",
    "Every result has status (ok|error) and next: follow next. Payment is only ever approved by the human in Stripe Checkout.",
  ].join("\n"),
});

registerTools(server);

export default server;
