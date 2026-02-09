---
title: "NDA deviation review agent"
slug: "nda-deviation-review-agent"
shortDescription: "Reviews NDAs against your standard template, highlights differences, and sends a risk rated summary to Slack."
heroIntroParagraph: "Highlight NDA deviations and send alert to Slack"
prompt: "Create an agent that reviews NDAs (Mutual or One-Way) and highlights deviations from standard terms.• Once I receive an NDA upload in a specified Google Drive folder• Extract clauses around confidentiality period, exclusions, governing law, and IP ownership.• Compare each clause to a company-approved template.• Generate a summary of differences and a risk assessment (Low / Medium / High).• Output a short summary in Slack and a detailed Markdown review.‍"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Legal"
categoryTags: ["AI Agents", "Data extraction"]
createdByTeam: "Anita Kirkovska"
integrations: [" Slack", "Gmail", "Google Drive"]
---

## Prompt

Create an agent that reviews uploaded NDAs from a specified {{Google Drive}} folder by extracting key clauses like confidentiality period, exclusions, governing law, and IP ownership, comparing them to a company approved template, assessing risk as Low Medium or High, and sending a short summary to {{Slack}} with a detailed Markdown review.

## Content

### Why you need it

‍ Most NDAs look the same at a glance, but small changes can create real risk. A longer confidentiality period, missing exclusions, tricky IP language, or unfamiliar governing law can slip through when you are moving fast. This agent helps you catch that. It extracts key clauses from an NDA, compares them to your company approved template, and highlights what is different. You get a quick risk rating so business owners know whether to sign, push back, or send to legal, along with a detailed Markdown review you can store or edit.

### What you need in Vellum

Text input for the NDA document A stored company approved NDA template in text form Logic that extracts key clauses such as confidentiality period, exclusions, governing law, and IP ownership A comparison step that checks each extracted clause against the template Scoring or rules to assign risk levels (Low, Medium, High) based on how far the NDA deviates Output formatting for a short Slack summary and a longer Markdown review A trigger to run the agent when a new NDA is uploaded or pasted

## FAQ

### How does the agent compare an NDA to our standard?

It parses the NDA, finds key clauses like confidentiality, exclusions, governing law, and IP ownership, and lines them up against the same sections in your approved template. It then flags additions, removals, and wording changes.

‍

### What goes into the risk rating?

The agent looks at how far each clause deviates from your baseline. For example, very different IP language or missing exclusions might be marked as High risk, while a small change to governing law might be Medium or Low, depending on your rules.

‍

### What do the Slack and Markdown outputs contain?

The Slack message is a short summary with NDA type, overall risk level, and a quick list of the main deviations. The Markdown review includes clause by clause notes, original vs template language where helpful, and a clear list of recommended follow ups.

‍

### Can it handle both Mutual and One Way NDAs?

Yes. You can pass in the NDA type as an input or let the agent infer it from the text, then apply slightly different comparison rules for each if needed.

‍

### Can we customize what counts as a deviation or high risk?

Yes. You can tune the prompts and rules so that certain changes are always flagged, adjust how strict you are for each clause, and refine what counts as Low, Medium, or High risk for your company.

‍
