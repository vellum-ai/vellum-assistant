---
title: "Stripe transaction review agent"
slug: "stripe-transaction-review-agent"
shortDescription: "Analyzes recent Stripe transactions for suspicious patterns, flags potential fraud, posts a summary in Slack."
heroIntroParagraph: "Flag suspicious Stripe transactions in Slack"
prompt: "Create an agent that analyzes transaction patterns to identify potential fraud. • Pull recent transactions from Stripe • Build Agent node with tools that will detect anomalies using rule-based and LLM pattern recognition (e.g., velocity, unusual merchant, location mismatch). • Summarize flagged cases in Slack {insert channel name} with supporting evidence. • Generate JSON output for fraud operations dashboards."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Finance"
categoryTags: ["AI Agents", "Document extraction"]
createdByTeam: "Anita Kirkovska"
integrations: [" Slack", "Stripe"]
---

## Prompt

Create an agent that analyzes transaction patterns to identify potential fraud. Pull recent transactions from {{Stripe}}. Then build agent with tools that will detect anomalies using rule-based and LLM pattern recognition (e.g., velocity, unusual merchant, location mismatch). Summarize flagged cases in {{Slack}}.

## Content

### Why you need it

‍ Fraud often shows up as small patterns across many transactions, not just one obvious bad charge. Manually scanning Stripe exports for strange velocity, odd merchants, or location mismatches is slow and easy to miss. This agent pulls recent transactions from Stripe, checks them with rules and LLM pattern detection, and flags anything that looks off. It sends a simple Slack summary with evidence for each case and produces JSON that your fraud or ops team can plug into dashboards or internal tools.

### What you need in Vellum

Stripe integration with access to recent transactions An input or config for lookback window, for example last 24 hours or last 7 days Logic or tools to apply rule based checks such as velocity, high value, country or IP mismatch An LLM step to look for unusual patterns that simple rules might miss A formatter that creates structured JSON with flagged cases, reasons, and scores Slack integration with a field for the target channel name or ID A summary template for posting flagged cases to Slack with short explanations A trigger such as a schedule that runs every hour, day, or week

## FAQ

### How does the agent get the transactions from Stripe?

It connects to Stripe with your API credentials, pulls recent transactions for the selected time window, and passes them into the analysis flow as structured data.

‍

### What kinds of fraud patterns can it detect?

It can look for transaction spikes on a single card, repeated small amounts, strange merchant or category usage, location or device changes, and other odd patterns that often show up in fraud.

‍

### How does it combine rules and LLM checks?

Rule based checks catch clear problems like too many payments in a short period. The LLM step then reviews the remaining data for more subtle patterns such as odd combinations of merchant, time, and location that do not match typical behavior.

‍

### What does the Slack summary include?

The Slack message lists each flagged case with key details such as transaction id, amount, user or card reference, suspected pattern type, and a short explanation of why it was flagged.

‍

### What is in the JSON output for dashboards?

The JSON includes one object per flagged case with fields like transaction id, user or account id, reason codes, risk score, timestamps, and notes. Your fraud team can feed this into internal dashboards or queue tools for follow up.

‍
