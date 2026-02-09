---
title: "Objection capture agent for sales calls"
slug: "objection-capture-agent-for-sales-calls"
shortDescription: "Take call transcripts, extract objections, and update the associated Hubspot contact record."
heroIntroParagraph: "Pull call objections and update HubSpot contacts"
prompt: "Create an agent that takes in call transcript and customer email address as text, extracts objections, and updates the associated HubSpot contact record. If a field for objections doesn't exist then create one."
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Sales"
categoryTags: ["AI Agents", "Evaluation"]
createdByTeam: "Nico Finelli"
integrations: [" Hubspot", "Gmail", "Gong"]
---

## Prompt

Create an agent that analyzes a {{Gong}} transcript, extracts objections, and updates the related HubSpot contact using the customer email.

## Content

### Why you need it ‍

Most objections happen live on calls and never make it back into the CRM. That means Sales, Success, and Product miss real signals about pricing pushback, missing features, timelines, and competitors. This agent fixes that. You give it a call transcript and the customer’s email address, it finds the right HubSpot contact, extracts the key objections, and logs them in a dedicated objections field. If that field does not exist, the agent creates it first. You end up with a searchable history of what customers are worried about instead of scattered notes in someone’s notebook or call recording tool.

### What you need in Vellum

A HubSpot integration with permission to read and update contacts Access to a text input for the call transcript Access to a text input for the customer email address Logic or prompting to extract clear objection statements from the transcript A step that looks up the HubSpot contact by email A step that checks if an objections field exists on the contact and creates it if not A step that writes or appends the extracted objections into that field A trigger to run the agent after calls, such as a manual run, webhook, or scheduled job tied to new recordings

## FAQ

### How does the agent match the transcript to the right contact?

It uses the customer email address you provide to look up the corresponding contact in HubSpot. If it finds a unique match, it updates that record with the extracted objections.

‍

### What exactly counts as an objection?

The agent looks for statements where the customer expresses concerns, blockers, or reasons not to move forward. For example, comments about price being too high, missing features, security requirements, timing, or choosing a competitor.

‍

### What happens if the objections field does not exist in HubSpot?

The agent checks for a dedicated objections property on the contact. If it does not exist, it creates a new custom field and then stores the extracted objections there.

‍

### What if the email does not match any contact?

If no contact is found for the provided email, the agent can either log an error, create a basic contact with that email, or skip the update, depending on how you configure the workflow.

‍

### Can it append to existing objections instead of overwriting them?

Yes. You can configure the update step to append new objections to the existing field content, for example by adding the latest call date and new objections below the previous notes.

‍
