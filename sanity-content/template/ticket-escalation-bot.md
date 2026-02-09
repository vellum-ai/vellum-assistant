---
title: "Ticket Escalation Bot"
slug: "ticket-escalation-bot"
shortDescription: "Detect escalated support tickets and assigns them in Linear."
heroIntroParagraph: "Auto-assign urgent tickets in Linear "
prompt: "Create an agent that detects when a support ticket is escalated (e.g., repeated follow-ups or high urgency). ‍Summarizes the full context and previous correspondence.Assigns it to the correct engineer in Linear and posts a summary to the { enter Slack channel name } channel."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Customer support"
categoryTags: ["AI Agents", "Chatbot / Assistant"]
createdByTeam: "Anita Kirkovska"
integrations: [" Linear", " Slack"]
---

## Prompt

Create an agent that detects escalated support tickets, summarizes context, assigns them in {{Linear}}, and posts a summary to a chosen {{Slack}} channel.

## Content

### Why this agent ‍

When tickets get hot, they usually bounce around. Customers send follow ups, urgency goes up, and someone on the team finally notices it is a mess. This agent catches those moments early. It spots escalated tickets, pulls together the full story, assigns the right owner in Linear, and posts a clear summary in your channel of choice. That means less time digging through threads and more time fixing the actual issue.

‍

### Prerequisites

‍ To run this agent in Vellum, you will need:

A Vellum account with access to Workflows or Agent Builder A connection to your ticket source (Example: Help Scout, Zendesk, Intercom, HubSpot, or another support tool API) A Linear integration set up API key and the right permissions to create and assign issues A Slack integration (Access to post messages in &nbsp;any channel you pick A way to mark or detect escalations (For example: tags, custom fields, or rules like number of replies or urgency field) A prompt or node that summarizes the full ticket history (Chat history and previous replies passed into the model as context)

With these in place, the agent can watch for escalations, write a summary, create or update a Linear issue, and notify your team in Slack automatically.

## FAQ

### 1) How does this agent know when a ticket is escalated?

You define the escalation signal. It can be a tag, urgency label, repeated follow ups, response time breaches, or any custom field from your support tool. The agent watches for those triggers and only runs when the criteria is met.

‍

### 2) What happens when an escalation is detected?

The agent gathers the full ticket history, summarizes the conversation, creates or assigns the issue in Linear, and posts a summary to a Slack channel of your choice, so the team can take over quickly.

‍

### 3) Can I choose which engineer it assigns tickets to?

Yes. You can map escalation types to engineers, round-robin assignments, or route based on keywords (billing, bugs, feature request, etc.). The routing logic is fully customizable inside Vellum.

‍

### 4) Do I need any integrations set up before using this?

You’ll need API access to your support tool, a Linear connection with permissions to create issues, and Slack permissions to post in the triage channel. Once connected, the agent handles the workflow automatically.

‍

### 5) Does the agent replace support reps?

No. It reduces the overhead of escalation handling. Instead of someone digging through long email threads to understand what’s happening, the agent does the summarization and routing, letting humans jump straight into solving the problem.
