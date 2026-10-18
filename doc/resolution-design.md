# Agent-resolved disputes: e-commerce edge cases as tool calls

**The question:** which buyer and seller pain points (refunds, chargebacks, and the messier ones around them) can be
reduced to a few tool calls that agents settle between themselves, without a person stepping in?

**The thesis:** a dispute is just another negotiation. We already have:
- a governing layer (the backend) that checks every move;
- agents that haggle within limits the owner set (floors, budgets);
- a messenger (Inkbox) that only says "something changed, go read it".

A dispute is the same loop, except the agents negotiate a **remedy** instead of a price. It runs over facts the
platform can verify, and within **policy limits** each side declared in advance. A person is needed only when those
limits don't overlap, or when a fraud signal fires.

## 1. Why this works better with agents than on a normal marketplace

Most dispute pain comes from two things:
1. **Nobody can prove what was agreed.** It's buried in a listing page that has since changed, a chat log, and an
   email.
2. **Resolving it is slow and manual.** Support queues, back-and-forth, and finally a bank chargeback (a fee for the
   seller, weeks for the buyer).

Exchangent already has the facts in machine-readable form:

| Fact | Where it lives today | Why it settles arguments |
|---|---|---|
| What was promised | The offer's structured items: category, attributes (`width_in: 46`, `ergonomic: true`), `unit_cents`, `delivery_days` | A "not as described" claim becomes a comparison: promised `width_in: 46`, measured 50. |
| What the buyer asked for | The request's structured requirements (`max_width_in: 48`) | A substitute can be checked automatically against the original need. |
| Who agreed, and when | The negotiation history plus Inkbox A2A delivery receipts (message ID, context, timestamp) | It's a complete, timestamped record of the deal. |
| That a person approved the payment | Reserve and Checkout are human-only (the agent can't pay). The Stripe session is bound to the reservation. | This is strong chargeback evidence against "I didn't authorize this". |
| The price per item | Reservation item snapshots | A partial refund for a missing chair is exact, not argued over. |

## 2. The edge cases

They're ranked roughly by how much pain they cause and how well they fit agents. **★ = distinctive to agent
commerce.**

### Buyer side

1. **Item not received, but the carrier shows it delivered.** Porch theft, wrong door. This is the top cause of
   disputes, and the buyer and seller are both telling the truth.
   - **Resolution:**
     - No carrier delivery scan by `deliver_by` + N days: automatic full refund.
     - A delivery scan exists: the seller's policy decides between a goodwill partial refund, a reship, or the seller
       filing a carrier claim while the buyer is refunded from the platform reserve.
2. **Not as described.** The desk is 50in, not 46in, or a different color. Bulky goods make returns expensive.
   - **Resolution:** compare the measured attribute against the offer. Remedies are:
     - **keep it with a discount**, often the cheapest for both sides (no return freight on a desk);
     - a return for a full refund, with the seller paying return shipping when the seller was at fault;
     - a replacement.
3. **Damaged in transit.**
   - **Resolution:** the buyer sends photo evidence. A vision check confirms "item visible, damage plausible". The
     buyer gets a quick partial refund or replacement, and the seller recovers from the carrier on its own schedule.
4. **Partial delivery.** The desk arrived, the chair didn't.
   - **Resolution:** a refund for the missing line item, exactly at its snapshot price. A desk-and-chair bundle is a
     natural demo of this.
5. **Late delivery, outside the promise.**
   - **Resolution:** an automatic SLA credit, such as the delivery fee refunded, when the delivery scan is later than
     `deliver_by`. No claim is needed; the platform notices.
6. **★ Price drop after purchase.** The seller's agent sells the same bundle for less two days later.
   - **Resolution:** the buyer's agent watches and claims the difference within a price-protection window the seller
     opted into. Agents are good at watching prices; people aren't.
7. **★ The seller oversold and can't fulfil.**
   - **Resolution:** the seller's agent proposes a substitute. The buyer's agent accepts automatically if the
     substitute **still meets the original structured requirements** and isn't more expensive. Otherwise the buyer is
     refunded in full. A person doesn't need to decide that "48in oak instead of 46in walnut" is fine; the
     requirements already say so.
8. **Changed my mind (remorse).**
   - **Resolution:** the seller's declared return window and restocking fee decide. Cancelling before it ships is
     free.
9. **Double charge or duplicate order.**
   - **Resolution:** detect it (the same buyer, seller and items within minutes) and refund the duplicate
     automatically.

### Seller side

10. **Friendly fraud: a chargeback after delivery.** The buyer goes to their bank instead of the platform. The seller
    loses the goods and pays a dispute fee.
    - **Resolution:** on `charge.dispute.created`, assemble the evidence automatically: the negotiation transcript,
      the human's explicit Checkout approval, the delivery scan and the attribute contract. Submit it through Stripe's
      dispute evidence API.
    - Before fighting, a **refund-or-fight calculator** compares the goods' value, the fee, the evidence strength and
      the seller's policy.
11. **Return abuse.** An empty box, a different item returned, or used-and-returned.
    - **Resolution:** on inspection the seller's agent files a counter-claim with photo evidence, and the refund is
      held until the return matches.
12. **Shipping cost surprise after the sale.** Dimensional weight on a desk costs more than quoted.
    - **Resolution:** policy says the price can't go up after the sale. The seller can absorb it, or propose a
      cancellation that the buyer's agent may accept. The seller's agent can never change the terms on its own.
13. **Failed delivery or a buyer no-show.** Large items need scheduling.
    - **Resolution:** a redelivery-fee negotiation, capped by policy.
14. **Getting paid, and payout holds.** New sellers worry they won't get paid; buyers worry about paying first.
    - **Resolution:** escrow. Funds are held until delivery is confirmed plus the dispute window, then released. That
      also funds instant refunds. (This needs Stripe Connect: separate charges and transfers, with delayed transfers.)

### ★ Problems that only exist because agents are trading

15. **"My agent bought something I didn't want."** That's an authority dispute.
    - **Resolution:** the request is a **mandate** (requirements, budget, target). The backend refuses anything outside
      it, and a person approves the payment, so a valid "outside my mandate" complaint is impossible by construction.
      Within the mandate, it's an ordinary return.
16. **Agents made promises in their notes.** For example, "delivered tomorrow, free assembly".
    - **Resolution:** **only structured terms are binding; notes are just talk.** Either the platform pulls promises
      out of notes into structured fields at offer time, or it tells both sides that notes aren't contractual.
17. **A prompt-injected or misbehaving agent.**
    - **Resolution:** limits are enforced by the backend, not by the model (floors, budgets, mandate, round caps). The
      worst outcome is a bad recommendation that the person still has to approve.
18. **Agents deadlock, or spam lowball offers.**
    - **Resolution:** round caps and rate limits, with a mediator rule: "split the difference between the last two
      offers, else close".

## 3. Reduced to tool calls

These are a few verbs that fit the pattern of the existing MCP tools. Every money-moving action is checked by the
backend against the order total, the escrow balance and both parties' policies.

**Buyer** (the person, or the buyer agent within the buyer's policy):

| Tool | Purpose |
|---|---|
| `confirm_received(order_id)` | Ends the dispute window early and releases escrow |
| `open_case(order_id, type, items?, description, evidence?)` | `type` is one of `not_received`, `not_as_described`, `damaged`, `missing_item`, `late`, `wrong_item`, `changed_mind`, `duplicate_charge` |
| `add_evidence(case_id, kind, ref)` | `kind`: `photo`, `measurement`, `text`, `tracking` |
| `respond_to_case(case_id, action, remedy?)` | `action` is `accept`, `counter` or `decline`; it works like `counter_offer` |
| `get_case(case_id)` | Read the case |

**Seller:**

| Tool | Purpose |
|---|---|
| `mark_shipped(order_id, carrier, tracking)` | Records shipment and starts delivery tracking |
| `report_fulfilment_issue(order_id, kind, substitute?)` | `kind` is `out_of_stock` or `address_problem` |
| `list_cases` | The seller's open cases |
| `respond_to_case(case_id, action, remedy?)` | Same as the buyer's |
| `set_resolution_policy({ ... })` | The policy fields are listed below |

The `set_resolution_policy` fields are:
- `auto_refund_not_received_after_days`
- `max_auto_partial_refund_pct`
- `return_window_days`
- `restocking_fee_pct`
- `pays_return_shipping_when_at_fault`
- `price_protection_days`
- `fight_chargebacks_above_cents`

**Remedy object (one shape for every case):**
```
{ kind: "refund_full" | "refund_partial" | "refund_items" | "replace" | "return_for_refund"
        | "keep_with_discount" | "sla_credit" | "cancel",
  amount_cents?, items?, return_shipping_paid_by?: "buyer" | "seller", note? }
```

**The platform** (runner plus backend, with no person involved):
- **Events over Inkbox:** `case.opened`, `case.offer`, `case.resolved`, `dispute.created`, the same as negotiation
  events.
- **The sweep resolves time-based cases:** no delivery scan by `deliver_by` + N becomes an automatic refund, a late
  scan becomes an SLA credit, and a closed window releases escrow.
- **Webhooks:** `charge.dispute.created` triggers evidence assembly and the refund-or-fight decision, then submission.
  `charge.refunded` keeps orders in sync.

**Resolution rule, which the backend decides and the model doesn't:**
1. If the facts settle it under a policy rule (no scan, late scan, a measured attribute mismatch), apply the
   remedy automatically.
2. Otherwise the agents negotiate a remedy inside **both** policy limits, exactly like price haggling: rounds,
   counters, a cap.
3. Only if the limits don't overlap, or a fraud signal fires (repeat claimants, a refund larger than the payment,
   evidence mismatch), does it go to a person.

## 4. What to build first (the smallest real version)

The money part works today in Stripe test mode, without Connect: refunds come off the platform charge.

1. **Order lifecycle:** `confirmed → shipped → delivered → closed`, plus `cancelled` and `refunded`. Add
   `mark_shipped` and `confirm_received`, with a simulated carrier scan for the demo (clearly labelled).
2. **Cases:** the `open_case` / `respond_to_case` remedy negotiation, reusing the sessions, versions and outbox
   machinery. Plus `set_resolution_policy`, with sensible defaults.
3. **Refunds:** `stripe.refunds.create` for `refund_full`, `refund_partial` and `refund_items`, bounded by the amount
   left to refund. Reflect `charge.refunded`.
4. **The ★ substitute flow:** when a seller oversells, a substitute is checked against the original requirements.
   It's the most distinctive demo.
5. **Chargebacks:** handle `charge.dispute.created` → evidence packet → refund-or-fight → `disputes.update`. Stripe
   test mode can simulate disputes with test cards.
6. **Later:** escrow with Stripe Connect, real carrier tracking webhooks, and vision checks on photo evidence.

**Demo stories this enables:**
- **"The chair never came."** The buyer opens a case and the platform refunds the chair line automatically. The
  seller's agent can't argue, because there was no scan.
- **"The desk is scratched."** The buyer sends a photo. The seller's agent offers a 15% discount to keep it, the buyer's
  agent counters at 25%, and they settle at 20% inside both policies. No people, and no return freight.
- **"Out of stock."** The seller's agent offers a 48in oak desk instead. The buyer's agent checks it against
  `max_width_in: 48` and accepts. The buyer gets an email.
- **"Chargeback."** The bank dispute arrives and the evidence packet is submitted automatically: the transcript, the
  human approval and the delivery scan.
