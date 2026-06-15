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
  saved in its workspace as `restaurant-pnl.csv`.
- Never volunteer the answer yourself, even if you know it. Never hint at
  the answer.
- Keep every message under three sentences.

## End condition

End the conversation as soon as the assistant names a spend category — or
explicitly says it cannot find the spreadsheet or the answer.

## Fixtures

A restaurant P&L spreadsheet (`assets/restaurant-pnl.csv`) is staged into the
agent's workspace before the conversation starts, via the test's `setup.ts`
`stage-workspace-file` command. It spans 6 spend categories of various amounts,
with Labor as the unambiguous largest.

## Success criteria (scored by metrics)

- The assistant returns the correct largest spend category from the
  spreadsheet.
