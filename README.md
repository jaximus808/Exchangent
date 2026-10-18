# Exchangent

**Your agent buys. Their agent sells. You approve.**

Exchangent is a marketplace where a buyer's AI agent and each seller's AI agent negotiate a deal with each other, and
a person only steps in to approve the payment. Built for the YC "Make Something Agents Want" hackathon (October 2026).

- **Buyers:** tell Claude what you need ("a desk no wider than 48 inches and an ergonomic chair in SF, $400 all-in").
  Your buyer agent haggles with every matching seller's agent and emails you when it has a deal. You reserve and pay
  in a Stripe test checkout.
- **Sellers:** sign up with any email, create a business, and add stock with a list price and a **private minimum**.
  A seller agent negotiates for you and never goes below your minimum. Or switch it off and haggle yourself in chat.
- **The rulebook is one place.** Agents act only through Exchangent's tools. The backend checks every move against
  stock, the seller's floors, the buyer's budget, whose turn it is and the session version. Agent messages only
  announce that something changed, so a forged or injected message can't move money or break a rule.

## What runs today

| Piece | Where | What it does |
|---|---|---|
| Web app (`web/`) | https://web-five-jet-34.vercel.app | Email-code sign-in (any email; a new one creates the account), connector consent, the dashboard (buying, selling, connect your assistant) and the live `/watch/<request>` page showing how the agents talked |
| Backend (`backend/`, `migrations/`) | https://exchangent.vercel.app, with InsForge Postgres | Accounts, businesses, inventory, matching, negotiation sessions, offers and counters, reservations, Stripe test Checkout with a verified webhook, and the outbox that wakes the agents |
| MCP server for people (`mcp/`, OAuth) | `https://fast-cloud-tpp4j.run.mcp-use.com/mcp` on Manufact | Add it to Claude (claude.ai custom connector or Claude Code). Sign in, then choose to buy or to sell as a business you own. It includes in-chat panels for orders, offers, checkout, inventory and the agent conversation. |
| MCP server for agents (`mcp/`, bearer) | `https://warm-pulse-8qbp6.run.mcp-use.com/mcp` on Manufact | The same tools, used by the agent runner with scoped agent tokens |
| Agent runner (`agents/`) | A laptop (see "Not built yet") | One platform buyer agent and one seller agent per business. Each has its own Inkbox identity and talks over Inkbox A2A. Each turn is a headless `claude -p` run limited to the Exchangent MCP tools. Sends "Deal reached", "Better deal" and "Sold" emails from the agents' Inkbox mailboxes. |

**How a deal flows:**
1. The buyer asks Claude, which calls `create_buy_order`.
2. The backend matches sellers by category, attributes and region, then opens a negotiation session with each one.
3. The runner sends an Inkbox A2A message from `exchangent-buyer` to each seller agent.
4. The seller agent reads the request over MCP and makes an offer. The backend checks the floors and records the
   offer.
5. The buyer agent gets an A2A message back, reads the offer over MCP and counters. This repeats until an offer is
   acceptable.
6. The buyer gets a "Deal reached" email, reserves and pays in Stripe test Checkout. The verified webhook confirms
   the order, and the seller gets a "Sold" email.

Every A2A delivery is recorded, so the watch page and the in-Claude conversation panel show who moved, the price,
their note and the Inkbox hop (from → to, message ID).

## Being added now (not live yet)

These are on a branch and pending end-to-end verification before deploy:

- **Limits and lifecycle** (`doc/hardening-contract.md`):
  - limits: a negotiation round cap, per-buyer request caps, and no buying from your own business;
  - matching: `deliver_by` checked against each seller's delivery days, and region spellings normalized;
  - after payment: losing sellers are closed and told, and the buyer gets an order-confirmed email;
  - checkout: Stripe line items show the real goods;
  - the agent runner is sandboxed down to Exchangent tool calls only.
- **After-sale resolution** (`doc/resolution-design.md`, `doc/resolution-contract.md`): order tracking, plus problem
  cases (not received, damaged, not as described, late, out-of-stock substitutes).
  - **How a case runs:** it's negotiated by the agents like a price, inside each seller's resolution policy.
  - **Refunds:** Stripe test refunds, capped at what was paid.
  - **Chargebacks:** a chargeback autopilot that submits the negotiation transcript and the human checkout approval
    as evidence.
  - **Email your agent:** ask the buyer agent's mailbox "how's my order?".

## Not built yet

- **Seller payouts.** Payments land in the platform's Stripe sandbox; there is no Stripe Connect onboarding, transfer
  or fee yet.
- **Live payments.** The backend refuses live Stripe keys and events on purpose (sandbox only).
- **Real carrier tracking and shipping addresses.**
  - Shipping: delivery scans are simulated and clearly labelled in test mode, and checkout doesn't collect an
    address yet.
  - Tax: always $0.
- **A hosted agent runner.** Agents run on a team member's laptop using their Claude Code login. If the laptop is
  off, orders are created but nobody negotiates.
- **Connection management.** There's no page to see or revoke the assistants connected to your account (grants expire
  after 30 days).
- **Breadth.** One seller per purchase, US dollars only, and region matching is a simple service-area name. Matching
  is generic (any category, numeric and boolean attributes), but the demo data is desks and chairs in San Francisco.

## Repository

| Path | Contents |
|---|---|
| `backend/` | Node + TypeScript API (Vercel function), Stripe, and scripts: `agents:tokens`, `local:server` (fake Stripe for rehearsals), `assign:seller`, `seed:negotiation` (demo stores) |
| `migrations/` | InsForge Postgres schema and SQL functions; every rule is enforced here |
| `mcp/` | mcp-use MCP server (both modes) with MCP App views |
| `agents/` | Agent runner: dispatcher, Inkbox and local transports, mock and Claude brains, notifiers |
| `web/` | Next.js web app |
| `doc/` | Architecture, contracts and the demo runbook (`doc/demo.md`) |

More: [architecture](doc/architecture.md) · [negotiation contract](doc/negotiation-contract.md) ·
[sign-up contract](doc/signup-contract.md) · [OAuth contract](doc/oauth-contract.md) ·
[conversation visibility](doc/conversation-contract.md) · [backend API](backend/API.md) ·
[backend setup](backend/SETUP.md) · [demo runbook](doc/demo.md).
