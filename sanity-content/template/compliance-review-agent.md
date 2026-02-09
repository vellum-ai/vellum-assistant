---
title: "Compliance review agent"
slug: "compliance-review-agent"
shortDescription: "Checks DPAs and privacy policies against your compliance checklist then scores coverage and make a plan."
heroIntroParagraph: "Review DPAs or privacy policies for compliance "
prompt: "Create an agent that checks data processing agreements (DPAs) or privacy policies for compliance with GDPR, CCPA, and other frameworks.• Parse documents and extract references to key obligations (data retention, subprocessor lists, breach notification).• Compare coverage against a compliance checklist.• Output a compliance score, missing elements, and action recommendations in a Slack channel of my choice"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Legal"
categoryTags: ["AI Agents", "Document extraction"]
createdByTeam: "Anita Kirkovska"
integrations: ["Vector db", " Slack", "Gmail"]
---

## Prompt

Create an agent that reviews DPAs or privacy policies, checks required obligations against a compliance checklist, scores compliance, flags gaps, and sends recommendations to {{Slack}} or {{Gmail}}.

## Content

### Why you need it

‍ DPAs and privacy policies are long, legal, and easy to skim past. You need to know if they actually cover core obligations like data retention rules, subprocessor transparency, and breach notification timelines. This agent reads the document for you, pulls out key clauses, compares them against a compliance checklist for frameworks like GDPR and CCPA, and then gives you a simple compliance score. It highlights missing elements and suggests actions so you can quickly see where you are covered and where you need updates or follow ups with vendors.

### What you need in Vellum

Text input for DPAs or privacy policies A reference checklist for GDPR, CCPA, and any other frameworks you care about Logic or prompts that extract key obligations such as data retention, subprocessor lists, and breach notification rules A comparison step that maps extracted content against the checklist Scoring logic that produces a single compliance score An output format that lists missing elements and clear action recommendations

## FAQ

### How does the agent analyze the document?

It parses the DPA or privacy policy text, finds clauses related to core obligations such as data retention, legal basis, subprocessing, data subject rights, and breach notification, then normalizes that information for comparison.

‍

### What frameworks can it check against?

Out of the box it can be set up for GDPR and CCPA. You can extend the checklist to cover other frameworks by adding your own requirements or regional rules.

‍

### What does the compliance score represent?

The score reflects how fully the document covers your checklist. Higher scores mean more items are clearly addressed, lower scores mean there are gaps or unclear language.

‍

### What do the action recommendations look like?

The agent lists specific gaps such as missing breach notification timelines or unclear subprocessor disclosure, and then suggests actions like update policy language, request an updated DPA from the vendor, or add an internal control.

‍

### Can I customize the compliance checklist?

Yes. You can edit the checklist items, add company specific requirements, and adjust how each item is weighted in the final score.

‍
