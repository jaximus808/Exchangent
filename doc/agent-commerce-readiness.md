# Agent commerce: demo readiness and lifecycle gaps

Reviewed against shared main `6ddb0b9` and the integrated local light-watch redesign.
Current release evidence and public-listing gates: `doc/connector-readiness.md`.
This is an implementation audit and product hypothesis, not proof of complete ecommerce coverage.
The immediate scope is the hackathon demo. Later work below is deliberately not presented as shipped.

## The product promise

A person gives an outcome and limits once. Their agent handles discovery, negotiation and routine follow-up.
The website and connected assistants read and change the same saved business state. The person can inspect,
pause and override their agent without recreating the transaction in another interface.

Conversational CRUD alone is not a differentiator: Shopify Sidekick already handles commerce tasks through
natural language. Our stronger hypothesis is cross-business competition and persistent negotiation, with
clear authority, human control and a reliable handoff to payment.
Source: https://help.shopify.com/en/manual/ai-powered-tools/sidekick

## What the teammate added

- Live buyer and seller negotiation conversations, including recorded Inkbox delivery receipts.
- An authenticated `/watch/<request_id>` page and the `get_conversation` MCP tool.
- A rewritten human dashboard: Overview, Buying, Selling and Connect.
- Self-service business creation, item creation and a seller-agent on/off switch in the website.
- Owner-only business/session/inventory routes; buyer-only conversation access.
- Migration `20261018000700_conversation.sql`. Applying it and deploying it remain separate from pulling code.

Our earlier inventory prototype is preserved in a named Git stash. Its API response shape differs from
this new dashboard. The compatible automatic-refresh and change-marker behavior is integrated into
Selling; the old duplicate endpoint/component must not be reapplied wholesale.

## The experiences that matter

| Scenario | Current implementation | Next requirement |
| --- | --- | --- |
| Sign in as buyer, seller or both | Email sign-in, role-bound MCP consent, shared web account | Make the active business and granted role unambiguous; verify reconnect and expiry |
| Create a business | Website and owner MCP tool | Clear retry behavior and a useful business-limit error |
| Add a new product | Website form and owner MCP upsert | Explicit SKU, variant identity and duplicate detection |
| Change title, price or minimum | MCP upsert exists; web has Add Item | Separate edit from create; preview changed fields; preserve item identity |
| Receive five more units | Absolute available quantity can be written | Atomic delta adjustment, operation key, reason and resulting quantities |
| A purchase happens while stock is edited | Reservation/payment stock changes are transactional | Prevent stale inventory upserts from restoring already-reserved stock |
| Item is damaged, missing, returned or counted wrong | Absolute stock write only | Distinct adjustment reasons and an immutable stock ledger |
| Stop selling a product | No per-product archive operation | Archive/restore; stop new offers without erasing order history |
| Pause a business or its agent | Backend business settings; web agent toggle | Distinguish no new sales from no autonomous negotiation; handle queued work |
| Set pricing and delivery rules | Floors and business delivery settings | Policy version, expiry, concession limits and human review of exceptions |
| A buyer has incomplete requirements | Agent can ask in chat | Ask only for information that prevents a valid offer; retain the rest |
| No sellers match or everyone declines | Empty states and declined sessions | Explain the failed constraint; offer a bounded requirement change |
| Two buyers want the last unit | Transactional reserve, stock checks | Rehearse contention; losing buyer gets alternatives, never a false promise |
| A cheaper offer arrives late | New offer/counter versions and agent behavior | Never silently replace the selected reservation or change an approved amount |
| Buyer changes quantity, budget or deadline | New request/counters exist; general request edit absent | Versioned edit; revalidate or reopen affected seller sessions |
| Buyer cancels a request | Seller decline exists; request cancellation absent | Stop new work, reconcile any checkout and acknowledge completion |
| Offer expires or changes during approval | Backend validation and reviewed-total guard | Consistent expiry ranking across every surface, not only the watch table |
| Checkout is interrupted or browser storage is lost | Backend saves reservations; local web fixes recover by request and reject foreign cached holds | Rehearse loss of storage and cross-device recovery on the deployed build |
| Payment is pending or webhook is delayed | Backend pending state; local watch and Buying suppress repeat payment and show verification | Deployed webhook delay and reconciliation rehearsal |
| Webhook or checkout call retries | Existing payment idempotency and event validation | Replay and out-of-order acceptance checks; never confirm from redirect alone |
| A buyer pays and seller must deliver | Confirmed order and notice plumbing | Seller order inbox, delivery address, promised terms and fulfillment state |
| Partial shipment, pickup, tracking, delay | Shipping, simulated delivery and received confirmation now exist | Explicit fulfillment records and permitted human/agent transitions |
| Cancellation after payment, return, exchange, refund | Policy-bound cases, remedies and test refunds now exist | Reason, eligibility, approval policy, financial status and independent restock decision |
| Agent stops, token expires or machine shuts down | Local runner, delegation/token machinery | Hosted runner, renewal rules, durable retry and a truthful worker heartbeat |
| Owner takes over mid-negotiation | Seller toggle and manual MCP negotiation | Re-check authority at execution; show which actions actually happened |
| Owner asks to undo or delete | Some business fields editable; no general undo | Archive and compensating actions; preserve completed financial records |
| Multiple staff, locations or sales channels | One owner, internal demo inventory | Scoped membership and a clear external system of record; reconcile outside sales |
| A seller embeds malicious instructions in an offer | Backend constraints and role checks | Treat notes as data; test instruction injection, private-limit leakage and scope escalation |
| Email/transport fails | Outbox and delivery receipts exist | Show recorded delivery separately from successful agent execution or email receipt |
| User loses connection or returns on another device | Saved requests and polling | Last-known state, useful errors, exact entity deep links and safe recovery |

The actor/action ledger should record the actual credential, role, business, policy version, before/after
values and operation ID. Current negotiation transcripts are useful evidence, but do not replace a full
inventory/settings/permissions audit trail. Changing today's delegation flag must not rewrite who acted yesterday.

## Authority: what may run independently

Autonomy is defined by a server-enforced policy, not by a model's confidence.

- **Read and reason:** discover matching goods, compare offers, summarize progress and flag exceptions.
- **Execute within a standing mandate:** negotiate within floors/budgets; decline unsuitable requests;
  retry safe reads; notify through an explicitly approved channel; update tracking from an authoritative feed.
- **Execute a specific owner's instruction:** create/edit an identified product or receive stock, once
  implemented with validation, concurrency protection, idempotency and a recorded result. A background
  negotiation agent does not automatically inherit the owner's catalog-management authority.
- **Escalate outside the mandate:** lower a private minimum, increase a buyer budget, substitute an essential
  requirement, exceed a refund allowance, make a novel delivery promise or perform a destructive bulk change.
- **Human-only in this demo:** final payment approval, permission expansion, business ownership changes and
  destructive deletion. Policy-bound test refunds are now implemented; success must come from the verified refund state. Seller payouts and live payments remain outside this demo.

Later, a buyer could grant limited spending authority. Those would
need explicit authorization, expiry, amount/action limits and a real financial integration. Buyer autonomous spending is not enabled; seller refund policies now exist but need a separate live sandbox rehearsal.

## Seamless agent interaction contract

Every mutation should accept an operation ID and return the saved entity ID, authoritative state/version,
changed fields, permitted next actions and whether any human decision remains. Retries return the original
result. Stale versions are explicit conflicts, never quiet overwrites. Uncertain upstream outcomes stay
pending until reconciled. Bulk operations need item-level results and a bounded scope.

The UI reports outcomes and exceptions, not model reasoning or fictitious agent activity. A live polling
connection does not prove a worker is running. “Delivered” does not prove the recipient finished a turn.
A paid order does not prove a seller email arrived or that the goods shipped.

Inventory should expose available, held/reserved and sold quantities with distinct meanings. Restock is
an addition; stocktake is a conditional absolute replacement. Example: agent reads 5, a buyer reserves 1,
then the agent writes 10 for “add 5”: the correct result was 9. Current upsert can lose that intervening change.
Use a transactional delta operation or compare-and-swap with an operation key.
References: https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps and
https://shopify.dev/changelog/posts/finalizing-compare-and-swap-redesign-for-inventory-set-quantities

## Hackathon acceptance gate

After-sale test flows are integrated, but keep them optional until the basic purchase demo is dependable.

1. Two distinct people connect as buyer and seller; unauthorized cross-account reads fail.
2. Seller adds inventory in chat; the website updates and shows the correct business and quantity.
3. Buyer submits a request; matching sellers receive it without the human refreshing or prompting each one.
4. Agents negotiate while the human watches, respecting floors, budget, stock and turn/version checks.
5. A request with no matches has a useful outcome; an expired offer cannot win a current-price comparison.
6. The human reviews the exact offer and amount; any material change requires another review.
7. A reservation survives closing the panel, losing local storage and changing devices.
8. Pending payment never offers a second payment; verified payment confirms once and changes stock once.
9. Owner pauses the seller agent; queued unauthorized actions cannot execute afterward.
10. Restart the runner mid-flow; verify recovery, or label persistence as unverified and keep the demo supervised.

Payment guidance: https://docs.stripe.com/checkout/fulfillment and https://docs.stripe.com/webhooks
Refund lifecycle reference for later: https://docs.stripe.com/refunds

## Local work in this pass

- Light watch interface, ranked seller comparison, filterable shared activity feed and compact outcome/progress.
- Paid seller resolved from the reservation, rather than a later lowest offer.
- Expired offers excluded from watch ranking. Pending and incomplete confirmation states remain verification.
- Exact-request links from the watch page to Buying, server-backed reservation recovery and request-specific cached hints.
- Buying suppresses repeat payment during verification and only renders a confirmed receipt from consumed/confirmed states.
- Selling refreshes inventory every five seconds while visible, shows update failures and marks quantity changes.

These changes and local tests are not a deployment or a full live-service rehearsal. Remaining demo blockers
include runner credentials/hosting, deployment/migration verification and the full sandbox checkout rehearsal.
