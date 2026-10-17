# Verified reservation and payment milestone

Verified October 17, 2026, against the dedicated Exchangent InsForge project and
Stripe sandbox account `acct_1URbMuIve5dAZQ3d`. No real funds or personal cards used.

## End to end result

1. Created an explicit fictional seller, desk and chair inventory, a $400 buyer
   request and a $365 offer ($200 desk, $140 chair, $25 delivery; $0 demo tax).
2. Reserved the offer using the transactional database function. Concurrent retry
   returned the same reservation and held each inventory item only once.
3. Created a real hosted Stripe test Checkout Session. Concurrent retry returned
   the same session using its persisted parameters and stable idempotency key.
4. Completed hosted Checkout with Stripe's standard test card and fictional buyer
   details. Link information saving was disabled.
5. Stripe CLI forwarded the real `checkout.session.completed` event. The server
   verified its raw-body signature, retrieved current session state from Stripe,
   matched the amount/currency/reservation, and atomically confirmed the order.
6. Replayed the paid event concurrently. The order, inventory and confirmation
   outbox remained unchanged.

| Evidence | Value |
| --- | --- |
| Reservation | `f00f9a82-3e9a-4bdc-9813-1f725711197c` |
| Checkout Session | `cs_test_a1ffWNnVfla8JFra2dIySbn7sdLaEYEv5uqoaY9SitHq5TBYXSbGNJClRH` |
| Verified Stripe event | `evt_1URdxFIve5dAZQ3dzfm3tsn6` |
| Confirmed order | `47582dd4-6d29-4c8b-811a-8fdba9b6408f` |
| Total | `36500` cents, USD |
| Reservation state | `consumed` |
| Each stock item | Available `0`, sold `1` |
| Confirmation event | One `order.confirmed` outbox row; email not sent |

## Automated checks

`npm test --prefix backend`: 6 passed.

- Reject live credentials and session identity/price mismatches.
- Reject invalid webhook signatures before database writes.
- Retrieve authoritative session state before confirmation.
- Keep completed-but-unpaid checkout pending without releasing stock.
- Do not let an old expiry event undo a paid session.
- Reject incorrect totals even with a valid signature.

`npm run test:integration --prefix backend`: 6 passed against real services.

- Reject another buyer, below-floor, over-budget and expired offers.
- Concurrent requests for one remaining item produce exactly one reservation.
- Unavailable bundle item rolls back every stock change and the reservation.
- Replaying the paid event creates no extra order, sale or notification row.
- Anonymous clients cannot read private tables or invoke server RPCs.
- HTTP endpoints reject missing authentication and invalid webhook signatures.

## Limits

This is a local, test-only transaction harness. Public user/worker authentication,
the Next.js integration, negotiation tools, notification delivery, and scheduled
cleanup/reconciliation are not implemented. The API must remain loopback-only
until demo authentication is replaced. Test actors with no auth user exist only
for this explicitly seeded proof. No delivery or real seller payout is implied.
