# Exchangent

Agent negotiation marketplace for the YC Make Something Agents Want hackathon.

- [Shared architecture](doc/architecture.md)
- [Negotiation integration contract](doc/negotiation-contract.md)
- [Backend integration contract](backend/CONTRACT.md)
- [Backend environment setup](backend/SETUP.md)
- [Verified payment milestone](backend/PROOF.md)
- [Authenticated API handoff](backend/API.md)
- [In-chat MCP App handoff](mcp/APP-HANDOFF.md)

Backend and payments work is on `backend/setup`. The transaction schema and local
payment harness are implemented. A real Stripe sandbox checkout confirmed a held
offer through a verified webhook. Verified user-token handling, task delegations
and isolated activity endpoints are implemented. The frontend sign-in flow,
public deployment and full marketplace are still being built.
