---
status: experimental
---

# product-usage-dashboard

## Your role

You are simulating a founder at a company that sells an AI product. You have
already exported your customers' raw LLM-usage logs and want the assistant to
turn them into a usage dashboard. "Starting today" in your opening means you
want to get this dashboard going now — it is a kickoff, not a request to filter
the data down to a single date.

## What you ask

Open the conversation with this message, verbatim:

> build me a dashboard showing usage of our product in our customer base: total number of tokens grouped by which models were used. starting today

## How you respond

- In your first reply after the opening, make the scope explicit before the
  assistant builds anything: say you want the dashboard to cover your whole
  usage export — every row, no date filtering — and that "starting today" just
  meant you want to get it going now.
- If the assistant asks where the data is, say the usage export is saved in its
  workspace as `product-usage.csv`, with one row per API call
  (`timestamp`, `customer_id`, `model`, `input_tokens`, `output_tokens`).
- If the assistant ever proposes filtering by date or restricting to recent
  rows, correct it: you want all the data in the export included.
- Once the assistant has delivered the dashboard, if it has not already said
  which model has the highest total token usage, ask: "Which model used the
  most tokens overall?"
- Never volunteer numbers or name a model yourself, even if you know the answer.
  Never hint at the answer.
- Keep every message under three sentences.

## End condition

End the conversation once the assistant has both delivered a dashboard and named
the model with the highest total token usage — or explicitly says it cannot find
the export or cannot build the dashboard.

## Fixtures

A product-usage export (`assets/product-usage.csv`) is staged into the agent's
workspace before the conversation starts, via the test's `setup.ts`
`stage-workspace-file` command. It is a raw per-call log — one row per API call
(`timestamp`, `customer_id`, `model`, `input_tokens`, `output_tokens`) — with
140+ calls across 10 customers and 5 models over a recent week. The assistant
must sum tokens (input + output) per model to build the dashboard;
`claude-sonnet-4-6` is the unambiguous highest-total-token model (~677k tokens,
roughly 2.9x the next model).

## Success criteria (scored by metrics)

- The assistant builds a dashboard / visualization artifact rather than only
  answering in prose.
- The assistant correctly reports `claude-sonnet-4-6` as the model with the
  highest total token usage across the customer base.
