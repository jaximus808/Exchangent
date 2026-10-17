# Exchangent

Exchangent is a hackathon agent negotiation marketplace. A buyer states a purchase
brief; participating seller agents offer goods within owner-approved rules. A
buyer selects an offer and approves payment through Stripe sandbox Checkout.

The first category is a desk-and-chair bundle in San Francisco, USD, supplied by
one seller per purchase. The team plans a buyer success fee; fee collection has
not yet been added to the live backend. Seller participation is initially free.

Humans need understandable offers, approval boundaries and order status. Agents
need the same durable state through scoped APIs, even when chat is closed. The
teammate owns MCP hosting and the agent runner. The primary human interface is
an MCP App in ChatGPT/Claude, implemented in `mcp/views/` and served by Manufact.
Requests begin in conversation; focused panels display offers, business activity,
approval and verified order status. `web/` is an earlier optional prototype.

Current backend supports authenticated request creation/reads, offer reads,
reservations, checkout, confirmed orders and restricted task delegations. Matching and negotiation outbox events are implemented. The autonomous dispatcher,
seller onboarding, notification delivery and production connector account linking
remain integration work.
Never present illustrative offers or progress as live backend activity.
