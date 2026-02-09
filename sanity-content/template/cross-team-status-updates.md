---
title: "Cross team status updates"
slug: "cross-team-status-updates"
shortDescription: "Scans Linear for stale, blocked, or repeatedly reopened issues, flags patterns, and uses Devin to propose cleanup or refactor suggestions."
heroIntroParagraph: "Track team progress without standup meetings"
prompt: "Create an agent that pulls {{Linear}} updates, PR statuses, and release notes, then generates a weekly team update with per person task summaries, posting it to {{Slack}} and saving a full report as a {{Notion}} page."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2026-01-10T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Product"
categoryTags: ["AI Agents", "Coding"]
createdByTeam: "Anita Kirkovska"
integrations: [" Slack", " Linear", "Notion"]
---

## Prompt

Create an agent that pulls {{Linear}} updates, PR statuses, and release notes, then generates a weekly team update with per person task summaries, posting it to {{Slack}} and saving a full report as a {{Notion}} page.

## Content

### Why you need this

Weekly status updates are one of those tasks that look simple but eat a lot of time. Product ops or team leads end up chasing updates across Linear, GitHub, and release notes, then rewriting the same information for Slack and Notion. Important work gets missed, updates are inconsistent, and the summary often depends on who spoke up last.

This agent removes that busywork by pulling the data straight from the source and producing a clear, consistent snapshot of what each person worked on, what shipped, and what is still in progress.

### Why agents are a good fit

This is a perfect job for an agent because it is repetitive, cross tool, and rules driven. The agent can reliably read Linear changes, PR status, and release notes, map work to owners, and apply the same structure every week without bias or forgetting context. It does not replace human judgment, but it does automate the collection and formatting, so the team can focus on decisions and follow ups instead of writing updates.

## FAQ

### How does the agent know what each team member worked on?

It pulls ownership and activity directly from Linear issues, linked PRs, and release notes, then groups updates by assignee and contributor.

### What does the weekly update include?

It includes shipped work, in progress tasks, blocked items, and upcoming work, summarized per person and formatted for Slack and Notion.

### Can I customize the format or level of detail?

Yes. You can control which fields are included, how detailed the summaries are, and whether the Slack version is short or more detailed.

### Does this replace standups or status meetings?

No. It replaces manual status writing, not the conversations. The agent gives everyone the same baseline context so meetings focus on decisions, not updates.
