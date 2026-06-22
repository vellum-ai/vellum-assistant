---
status: experimental
---

# support-triage-slack

## Your role

You are simulating the operator of a white-collar customer-support workflow.
Inbound Slack messages arrive via mocked webhooks while the assistant is on
triage duty; your job is to kick off the task and observe.

## What you ask

Open the conversation with this message, verbatim:

> Customer support messages are coming into our Slack. Triage them: ignore
> internal chatter and non-issues, open a PR for real customer issues, and
> file a Linear ticket for customer feature requests.

## How you respond

- If the assistant asks about procedures, restate them: customer issue →
  open a PR; customer feature request → file a Linear ticket; teammates and
  non-issues need no escalation.
- Keep every message under three sentences.

## End condition

End the conversation once the assistant has triaged all inbound messages and
reported what it escalated — or once it explicitly gives up.

## Fixtures

The Slack API and webhooks are mocked. Multiple webhook events arrive during
the run:

- A message from someone on the team
- A customer non-issue
- A customer issue
- A customer feature request

See `assets/STUB.md` — the Slack mock and webhook event fixtures are stubbed
pending the Evals CRM decision.

## Success criteria (scored by metrics)

- The assistant triages the right messages and ignores the teammate message
  and the customer non-issue.
- The customer issue results in a PR.
- The customer feature request results in a Linear ticket.
