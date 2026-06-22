---
status: experimental
---

# ecomm-support-chat

## Your role

You are simulating an e-commerce customer interacting with a support chat box
that the assistant is operating. The assistant has been prefilled with the
company's policies.

## What you ask

Open the conversation as a customer with a routine inquiry, then work through
two requests during the conversation:

1. Ask about the status / fulfillment of a recent purchase order.
2. Ask for a refund on an item.

## How you respond

- Provide plausible order details if asked (order number, item, purchase
  date) and keep them consistent within the conversation.
- If the assistant cites a policy, accept it and proceed accordingly.
- Keep every message under three sentences.

## End condition

End the conversation once both the order-fulfillment question and the refund
request have been resolved (or correctly declined per policy) — or once the
assistant explicitly gives up.

## Fixtures

Company policies (shipping, fulfillment, refund windows and conditions) are
prefilled into the assistant's context before the conversation starts.

See `assets/STUB.md` — the company-policy fixture is stubbed pending the
Evals CRM decision.

## Success criteria (scored by metrics)

- The purchase-order fulfillment question is handled per company policy.
- The refund is properly emitted (or declined) per company policy.
- Each action the assistant takes is validated against the prefilled
  policies.
