---
title: "Active deals health check agent"
slug: "active-deal-health-check-agent"
shortDescription: "Sends a weekly HubSpot deal health update, ranks deals and enables the sales team."
heroIntroParagraph: "Get weekly HubSpot deal health insights"
prompt: "Create an agent that gives a weekly update on active deals in Hubspot, summary consisting: of size of deal, last communication, % likelihood, next activity date etc. Ranks Green, Yellow, Red deals. Wraps up any past close date deals (Red). Prompts user to either move close date or change to close lost with reason. Send report to Gmail."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Sales"
categoryTags: ["AI Agents", "Chatbot / Assistant", "Data extraction"]
createdByTeam: "Nico Finelli"
integrations: [" Hubspot", "Gmail", " Slack"]
---

## Prompt

Create an agent that sends a weekly {{HubSpot}} active deals report to {{Gmail}} and {{Slack}} with deal size, last communication, likelihood percent, and next activity date, grouped into Green Yellow Red, flags any deal past its close date as Red, and prompts you to either update the close date or mark it closed lost with a reason.

## Content

### Why you need it ‍

Active deals often look fine in the pipeline but can quietly stall. Close dates slip, last contact gets older, and no one notices until it is too late. This agent gives you a simple weekly view of deal health. It pulls active deals from HubSpot, summarizes key info like deal size, last communication, close likelihood, and next activity date, then ranks each one as Green, Yellow, or Red. Any deal with a past close date is flagged as Red and the agent prompts you to either move the close date forward or convert it to Closed Lost with a reason. You get a clear picture of where to focus and a gentle push to keep your pipeline honest.

### What you need in Vellum

HubSpot integration with access to deals Fields for deal amount, last activity date, close probability, next activity date, close date, and stage Logic that assigns Green, Yellow, or Red based on recency, next steps, and close date A check that flags deals with past close dates as Red A step that prompts the user to move the close date or mark the deal as Closed Lost with a reason An output channel for the weekly update such as Slack, email, or Notion A weekly schedule trigger to run the agent and send the summary

## FAQ

### How does the agent rank deals Green, Yellow, or Red?

It looks at fields like last communication date, next activity date, close date, and close probability. Green deals are on track with recent activity and future steps, Yellow deals show some risk such as older activity or weak next steps, and Red deals are stalled or past their close date.

‍

### Which deals are included in the weekly update?

The agent pulls deals from HubSpot that are in an active stage, not Closed Won and not Closed Lost. You can refine this filter by pipeline, owner, or minimum deal size if you want a tighter focus.

‍

### What happens with deals that have a past close date?

Any deal with a close date in the past is flagged as Red. The agent then prompts you to either move the close date to a realistic new date or convert the deal to Closed Lost and add a loss reason.

‍

### Where does the weekly summary get sent?

You can configure the agent to send the summary to Slack, email, Notion, or another channel. Many teams send a short list of Green, Yellow, and Red deals to a shared Slack channel and a more detailed view to the deal owners.

‍

### Can I customize the rules for deal health?

Yes. You can adjust how many days count as stale, what probability thresholds you consider risky, and which fields should influence Green, Yellow, or Red. You can also change how often the agent runs if you want more than a weekly update.
