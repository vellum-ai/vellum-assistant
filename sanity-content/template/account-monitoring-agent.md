---
title: "Account monitoring agent"
slug: "account-monitoring-agent"
shortDescription: "Combines product usage data with CRM data from HubSpot or Salesforce to flag accounts with declining usage, especially ahead of renewals."
heroIntroParagraph: "Detect declining usage trends ahead of renewals"
prompt: "Create an agent that pulls product usage data from {{PostHog}} and account data from {{Salesforce}}, detects declining usage trends, flags at risk accounts ahead of renewal dates, and outputs a prioritized list with risk level and recommended next actions in {{Notion}}."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2026-01-10T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Product"
categoryTags: ["AI Agents"]
createdByTeam: "Anita Kirkovska"
integrations: ["Notion", " PostHog", "Salesforce"]
---

## Prompt

Create an agent that pulls product usage data from {{PostHog}} and account data from {{Salesforce}}, detects declining usage trends, flags at risk accounts ahead of renewal dates, and outputs a prioritized list with risk level and recommended next actions in {{Notion}}.

## Content

### Why you need it

Declining product usage is one of the earliest signs of churn, but it is easy to miss when usage data lives in analytics tools and renewal dates live in the CRM. Teams often notice the risk too late, after a renewal is already in trouble. This agent connects those signals early by watching usage trends alongside upcoming renewals, giving Product, CS, and Sales a clear list of accounts that need attention before it is urgent.

### What you can do with it

You can proactively reach out to at risk accounts, prioritize QBRs, share relevant feature updates, and align product and customer teams around the same risk signals. The Notion output becomes a living workspace where teams track follow ups, add notes, and coordinate actions across accounts.

### Why agents are good for this

This task is ideal for an agent because it requires pulling data from multiple systems, applying the same logic consistently, and running on a schedule. An agent can continuously monitor usage trends, match them to CRM records, and surface risks without manual analysis. Humans stay focused on decisions and conversations, while the agent handles detection, scoring, and reporting.

## FAQ

### How does the agent detect declining usage?

It compares recent usage trends from PostHog against a historical baseline and looks for sustained drops in activity rather than one off fluctuations.

### How are accounts prioritized?

Accounts are ranked using a mix of usage decline severity, renewal date proximity, and account importance from Salesforce.

### What does the Notion output include?

Each account includes usage trends, renewal date, risk level, and suggested next actions that teams can update and track.

### Can this run automatically?

Yes. The agent can run on a schedule, such as weekly or daily, to keep the risk list continuously up to date.
