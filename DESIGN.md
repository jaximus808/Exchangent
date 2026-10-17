# Exchangent interface

## In-chat buyer and seller panels

Mode: Operate. The primary task is comparing a small set of negotiated offers,
understanding what the agent has done and explicitly approving a purchase.

The user selected a white/light palette with no bright accents, orange or
AI-themed gradients. References are the precision and calm of Ramp and Stripe's
product interfaces, without reproducing their brands. The product should feel
friendly through clear language, comfortable spacing and predictable controls.

Use a readable host-compatible sans serif, white surfaces, charcoal text
and primary actions, muted gray secondary text, subtle one-pixel borders. Color
must never carry status alone. No decorative illustrations, gradients or hero
marketing treatments. Financial values use tabular numerals.

The primary interface renders inside ChatGPT/Claude as MCP App panels served by
Manufact. Conversation collects the brief; panels show competing offers, activity,
seller inventory and checkout status. Use compact headers, stacked offer cards,
clear totals and explicit purchase review. Adapt to narrow iframe widths without
adding website navigation or a separate sign-in form. Use host-mediated tools,
follow-up messages and external-link opening; never direct browser API calls.
The older standalone layout in `web/` is not the hackathon's primary experience.

Motion communicates selection, modal appearance and status updates in 150–220ms.
Honor reduced motion. Every form has labels, errors and pending feedback. Keyboard
focus must be visible. Preview data is clearly labeled and never reaches checkout.
