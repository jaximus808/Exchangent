# Exchangent: product

## The idea

Buying and selling still means a person comparing listings, haggling in messages, and arguing with support when
something goes wrong. Exchangent gives each side an agent and puts the rules in one place:
- **A buyer's agent** negotiates for the buyer within the budget, target and requirements they set.
- **Each seller's agent** negotiates for its business within the private floors and stock the owner set.
- **The platform** is the rulebook. Agents can only act through Exchangent's tools, and the backend enforces every
  constraint, so the agents can be autonomous without being trusted.

People stay in charge of the things that matter: buyers approve every payment in Stripe, and owners set floors,
stock and whether their agent negotiates at all.

## Who uses it

- **Buyers.** Anyone who signs in with an email and connects Claude. They describe what they want once, and get one
  email when a deal is ready.
- **Sellers.** Anyone who creates a business. They stock it from Claude or the web dashboard with list prices and
  private minimums. Their agent handles the haggling, and they get a "Sold" email.
- **Agents.** The platform buyer agent and one seller agent per business. They run as headless Claude Code turns,
  talk to each other over Inkbox A2A, and act only through the MCP tools with scoped tokens.

## Principles

1. **The backend is the governing layer.**
   - Floors, budgets, stock, turns and versions are checked in SQL, inside the same transaction that records the move.
   - An agent can't exceed its mandate even if its model is confused or manipulated.
2. **Messages carry no authority.** An Inkbox message only says "something changed, go read it". Every agent
   re-reads state over MCP before it acts.
3. **Private stays private.** Buyers never see seller floors. Sellers never see buyer budgets, targets or emails.
4. **Humans approve money.** Agents can't reserve or pay. A person reserves and pays through Stripe Checkout, and only
   the verified webhook confirms an order.
5. **Honest about what's real.** Simulated pieces (sandbox payments, simulated delivery scans) are labelled as such in
   the product.

## What's live today

- **Accounts:** email-code sign-in with any email, plus connector OAuth for Claude (claude.ai and Claude Code).
- **Selling:** self-serve businesses with inventory, list prices and private floors.
- **Matching:** by category, numeric and boolean attributes, and service area. One negotiation session opens per
  matching seller.
- **Negotiation:** autonomous haggling between the platform buyer agent and each seller agent over Inkbox A2A. A
  seller can turn its agent off and haggle by hand. A late, cheaper offer reopens the deal and sends a "Better deal"
  email.
- **Visibility:**
  - the live watch page and the in-Claude conversation panel, with every A2A hop;
  - the web dashboard for buying (orders, offers, reserve and pay) and selling (inventory, the agent switch, live
    negotiations).
- **Payments and emails:** Stripe test Checkout with a verified webhook. "Deal reached", "Better deal" and "Sold"
  emails come from the agents' own Inkbox mailboxes.

## Next (in progress)

The full designs are in `doc/resolution-design.md` and `doc/hardening-contract.md`.

- **Safety limits.** Round and request caps, no self-dealing, delivery dates enforced in matching, losing sellers
  closed and notified, and the agent runner sandboxed to tool calls only.
- **After-sale resolution**:
  - **Disputes are negotiations.** A problem case (not received, damaged, not as described, late, out of stock)
    is a negotiation over a remedy instead of a price.
  - **Facts first.** Facts the platform can verify settle the case automatically: no delivery scan, a late scan, the
    attribute contract in the offer, or a duplicate charge.
  - **Policy second.** Otherwise the agents negotiate inside the policy each seller declared in advance.
  - **A person last.** Only cases where the two policies don't overlap reach a person.
  - **Money:** refunds go through Stripe, capped at what was paid. Chargebacks get an evidence packet automatically
    (the negotiation transcript, the human checkout approval and delivery records).

## Not built yet

- **Seller payouts:** Stripe Connect, escrow until delivery, and a platform fee. Today the platform's sandbox account
  receives every payment.
- **Live payments:** sandbox only, by design for now.
- **Shipping:** real carrier tracking and shipping addresses (delivery is simulated in test mode). Tax is $0.
- **A hosted, multi-tenant agent runner.** It runs on a laptop with a personal Claude Code login today.
- **Connection management:** seeing and revoking connected assistants.
- **Breadth:** multi-seller carts, currencies other than USD, and real geography for service areas.
