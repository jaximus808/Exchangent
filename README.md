# Exchangent

Agent negotiation marketplace for the YC Make Something Agents Want hackathon.

- [Shared architecture](doc/architecture.md)
- [Negotiation integration contract](doc/negotiation-contract.md)
- [Backend integration contract](backend/CONTRACT.md)
- [Backend environment setup](backend/SETUP.md)
- [Verified payment milestone](backend/PROOF.md)

Backend and payments work is on `backend/setup`. The transaction schema and local
payment harness are implemented. A real Stripe sandbox checkout confirmed a held
offer through a verified webhook. The full marketplace and public authentication
are still being built.
