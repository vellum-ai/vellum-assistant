---
title: "Contract review agent"
slug: "contract-review-agent"
shortDescription: "Reviews contract text against a checklist, flags deviations, scores risk, and produces a lawyer friendly summary."
heroIntroParagraph: "Review my contracts and generate risk summaries"
prompt: "Create an agent that reviews contract text against a checklist, extracts key clauses, flags deviations, and generates a lawyer friendly risk summary.Inputs: Contract text, checklist, risk profile (Low / Medium / High)Flow: Parse documents to structured JSON, compare clauses to checklist items, identify missing or risky language, score each issue, categorize risks, and recommend mitigations. Final output should include an executive summary, redline style CHANGE FROM / TO suggestions, and negotiation guidance.Outputs: Add the summary in the next available row in my Google Sheet {enter name}, with the analysis insights and a contract identifier.‍"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Legal"
categoryTags: ["AI Agents", "Data extraction", "Document extraction"]
createdByTeam: "Anita Kirkovska"
integrations: ["Google Sheets", "Vector db"]
---

## Prompt

Create a contract review agent that parses documents into structured JSON, checks clauses against a checklist, flags missing or risky language, scores and categorizes each issue, and suggests mitigations. Output an executive summary, redline CHANGE FROM / TO edits, negotiation guidance, and save results as a row in {{Google Sheets}}.

## Content

### Why you need it ‍

Contract review is slow and tiring, especially when you need to line up every clause against a long checklist. Small changes in wording can hide real legal, financial, or compliance risk, and those are easy to miss when you are moving fast. This agent reads the contract text, extracts key clauses, and compares them to your company checklist. It flags what is missing or risky, scores each issue based on your risk profile, and explains what to change. You get an executive summary, clear CHANGE FROM and CHANGE TO suggestions, and simple negotiation guidance that lawyers and business owners can both use.

### l

Input for contract text Input for a checklist document with required clauses and rules Input for risk profile such as Low, Medium, or High A parsing step that converts contract sections and checklist items into structured JSON Logic to extract key clauses and match them to checklist items A comparison step that flags missing terms and risky language Risk scoring logic that uses the risk profile and categorizes issues as legal, financial, or compliance A summary step that generates Executive summary and overall risk overview Clause level CHANGE FROM and CHANGE TO recommendations Negotiation and approval guidance

- Outputs for JSON flagged issues with risk scores and mitigation notes
- Markdown legal review summary

## FAQ

### How does the agent use the checklist?

It reads the checklist document, turns each requirement into structured items, then matches contract clauses to those items. Anything missing, weakened, or changed is flagged as a deviation.

‍

### What kind of risks can it detect?

It can highlight legal, financial, and compliance risks, such as missing liability limits, unusual indemnity language, unclear data protection terms, or unbalanced termination rights.

‍

### How is the risk profile used?

The risk profile input tells the agent how strict to be. For example, with a High risk profile, it will treat more deviations as significant and assign higher risk scores. With a Low risk profile, it may only flag larger changes.

‍

### What does the JSON output contain?

The JSON includes each flagged issue, the related clause or checklist item, a risk score, a risk category, and suggested mitigation or wording changes. This makes it easy to plug into other tools or dashboards.
