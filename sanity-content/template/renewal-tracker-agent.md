---
title: "Renewal tracker agent"
slug: "renewal-tracker-agent"
shortDescription: "Create an agent that scans HubSpot for deals with upcoming renewal dates in the next 60 days. "
heroIntroParagraph: "Monitor renewals in Hubspot and alert me in Slack"
prompt: "Create an agent that scans HubSpot for deals with upcoming renewal dates in the next 60 days. ‍- Rank customers by renewal risk (High, Medium, Low) based on communication recency, usage metrics, and deal notes. - Send a weekly renewal risk summary to the account owner with action recommendations (e.g., “Schedule QBR,” “Share new feature update”). - Send this summary to a slack channel ID that the user provides as input"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Customer support"
categoryTags: ["AI Agents", "Data extraction"]
createdByTeam: "Akash Sharma"
integrations: [" Hubspot", " Slack"]
---

## Prompt

Create an agent that scans {{HubSpot}} for deals renewing in the next 60 days, scores renewal risk as High Medium or Low using recent communication, usage, and notes, and sends a weekly action focused summary to a user chosen {{Slack}} channel.

## Content

### Why you need it ‍

Renewals often look fine until they suddenly aren’t. Usage dips, communication slows, and warning signs get missed because they’re scattered across HubSpot activity, notes, and CRM fields. This agent keeps track of it for you. It scans for deals renewing in the next 60 days, ranks them by risk, and sends a weekly list with recommended actions like (Schedule QBR) or (Share feature update). It also sends that summary to a Slack channel you choose, so account owners and leadership stay ahead of churn instead of reacting to it.

‍

### What you need in Vellum

A HubSpot integration with access to deals A renewal date field to filter against Usage and communication activity available to reference A Slack integration with a provided channel ID Logic or prompting that assigns risk levels (High / Medium / Low) A weekly schedule trigger to send summaries

## FAQ

### How does the agent determine renewal risk?

It looks at recency of communication, product usage patterns, and deal notes. Based on those signals, it assigns a risk level of High, Medium, or Low.

### How often does it send renewal reports?

The default is weekly, but you can change the schedule in Vellum if you want more or less frequent check-ins.

### Where does the summary get delivered?

It sends a report directly to the account owner and also posts the same summary into the Slack channel you specify.

### Can I customize the recommended actions?

Yes. You can edit the prompt or scoring logic to suggest actions like scheduling QBRs, sharing product releases, or offering renewal incentives.

### What CRM fields are required for it to work well?

You need a renewal date field, deal notes, communication history, and some form of usage metric so the agent can score renewal risk accurately.
