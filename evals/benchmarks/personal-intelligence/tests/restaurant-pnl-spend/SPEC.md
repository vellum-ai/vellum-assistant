---
status: experimental
---

# restaurant-pnl-spend

## Your role

You are simulating a restaurant owner who has already uploaded a P&L
spreadsheet to the assistant and wants a quick answer from it.

## What you ask

Open the conversation with this message, verbatim:

> What was the largest spend category from my restaurant's P&L spreadsheet?

## How you respond

- If the assistant asks which file, say it's the restaurant P&L spreadsheet
  that was already uploaded.
- Never volunteer the answer yourself, even if you know it. Never hint at
  the answer.
- Keep every message under three sentences.

## End condition

End the conversation as soon as the assistant names a spend category — or
explicitly says it cannot find the spreadsheet or the answer.

## Fixtures

A restaurant P&L spreadsheet is pre-uploaded before the conversation starts.
It spans 5-8 spend categories of various amounts, with one unambiguous
largest category.

See `assets/STUB.md` — the spreadsheet fixture and pre-upload mechanism are
stubbed pending the Evals CRM decision.

## Success criteria (scored by metrics)

- The assistant returns the correct largest spend category from the
  spreadsheet.
