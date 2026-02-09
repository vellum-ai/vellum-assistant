---
title: "Closed-lost deal review agent"
slug: "closed-lost-deal-review-agent"
shortDescription: "Review all deals marked as \"Closed lost\" in Hubspot and send summary to the team."
heroIntroParagraph: "Review my closed-lost HubSpot deals weekly"
prompt: "Create an agent that reviews all deals marked as “Closed Lost” in HubSpot for the week.• Extract key details: deal size, loss reason, competitor, and stage lost.• Identify recurring themes or reasons (e.g., pricing, missing feature).• Summarize findings in a Slack or Notion update for the Sales and Product teams every Friday."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Sales"
categoryTags: ["AI Agents"]
createdByTeam: "Nico Finelli"
integrations: ["Notion", " Slack", " Hubspot"]
---

## Prompt

Create an agent that reviews Closed Lost deals from {{HubSpot}} each week, extracts deal size, loss reason, competitor, and lost stage, identifies recurring patterns like pricing or missing features, and posts a summary to {{Slack}} or {{Notion}} every Friday.

## Content

### Why you need it

‍ Closed Lost deals often get tagged and forgotten. The real value sits in the patterns. Are you losing on price, missing features, slow response times, or a specific competitor. This agent looks at every deal marked Closed Lost in HubSpot for the week, pulls out key details, and surfaces the real themes behind the losses. You get a simple Friday update that helps Sales adjust their approach and gives Product clear input on gaps, instead of digging through scattered notes.

### What you need in Vellum

HubSpot integration with access to deals A way to filter for deals with status Closed Lost Fields for deal size, loss reason, competitor, and stage A prompt or logic block that groups and counts recurring themes Slack or Notion integration for sending the weekly update A weekly schedule set to run every Friday

‍

## FAQ

### How does the agent know which deals to include?

It filters HubSpot for deals that are marked Closed Lost and were updated or moved into that stage during the current week. Those deals are the input set for the analysis.

‍

### What details does the agent pull from each deal?

It extracts core fields such as deal size, loss reason, competitor, and the stage where the deal was lost. It can also include owner, segment, or region if those fields are available.

‍

### How does it find recurring themes?

It looks at the loss reasons, competitor names, and notes and groups them into simple themes such as pricing, missing feature, timing, or wrong fit. The summary then highlights which themes show up most often.

‍

### Where is the summary sent?

The agent creates a short writeup that can be posted to Slack or written into a Notion page. You can pick Slack, Notion, or both when you set up the workflow.

‍

### How often does this run and can I change the timing?

By default it runs every Friday and looks at deals from that week. You can adjust the schedule in Vellum if you want a different day or cadence.

‍
