# Exchangent

Exchangent is a hackathon agent negotiation marketplace. A buyer states a purchase
brief; participating seller agents offer goods within owner-approved rules. A
buyer selects an offer and approves payment through Stripe sandbox Checkout.

The first category is a desk-and-chair bundle in San Francisco, USD, supplied by
one seller per purchase. The team plans a buyer success fee; fee collection has
not yet been added to the live backend. Seller participation is initially free.

Humans need understandable offers, approval boundaries and order status. Agents
need the same durable state through scoped APIs, even when chat is closed. The
MCP integration belongs to the teammate. The frontend is isolated in `web/`.

Current backend supports authenticated request creation/reads, offer reads,
reservations, checkout, confirmed orders and restricted task delegations. Matching,
negotiation worker events, seller onboarding and notification delivery are pending.
Never present illustrative offers or progress as live backend activity.
