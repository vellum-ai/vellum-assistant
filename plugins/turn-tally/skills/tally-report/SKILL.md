---
name: tally-report
description: >-
  Present a readable activity report for the current conversation from the
  turn-tally plugin's recorded counts. Use when the user asks how much
  activity, how many prompts, or how many tool calls this conversation has
  had.
metadata:
  emoji: "🧮"
  vellum:
    display-name: "Tally Report"
    category: "development"
    activation-hints:
      - "User asks how many prompts or messages they have sent"
      - "User asks how many tool calls the conversation has used"
      - "User asks for a conversation activity or usage report"
    avoid-when:
      - "User asks about token usage or billing, which this plugin does not track"
---

Produce a short activity report for the current conversation.

## Steps

1. Call the `turn_tally` tool with no arguments to read the current
   conversation's tally.
2. Present the counts as a short list: prompts sent, total tool uses, and
   the per-tool breakdown when one is present.
3. If the tool reports no recorded activity, say so plainly; do not
   estimate counts from the visible history.

Keep the report to a few lines. The counts come from the plugin's own
store and cover this conversation only.
