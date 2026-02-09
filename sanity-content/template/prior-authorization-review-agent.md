---
title: "Prior authorization review agent"
slug: "prior-authorization-review-agent"
shortDescription: "Reviews prior authorization packets, checks them against plan criteria and outputs JSON"
heroIntroParagraph: "Run review when new prior auth packets arrive"
prompt: "Create a prior authorization review agent that:A‍ccepts 3 documents (clinical notes, codes, medical necessity forms) and plan criteriaExtracts text from documents (GPT-5 requires text, not files)Uses agent tools to parse notes, extract codes, check coverage, and identify missing docsOutputs structured JSON summary with coverage determination, missing items, and recommendations‍"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Healthcare"
categoryTags: ["Data extraction", "Document extraction", "AI Agents"]
createdByTeam: "Anita Kirkovska"
integrations: ["Vector db", "EHR", "Google Drive"]
---

## Prompt

Create a prior authorization review agent that takes latest uploaded documents from {{Google Drive}}, extracts text, parses notes and codes, checks coverage against plan criteria, identifies missing items, and outputs a structured JSON summary with determination and recommendations.

## Content

### Why you need it

‍ Prior authorizations are slow because information is spread across clinical notes, codes, medical necessity forms, and plan criteria. Someone has to read everything, check coverage rules, and figure out what is missing. This agent does that work for you. It accepts three core documents and the plan criteria, extracts the text, parses diagnoses and procedure codes, checks coverage, and spots missing documentation. It then returns a structured JSON summary that shows coverage determination, missing items, and suggested next steps so your team spends less time on manual review and fewer requests get denied for avoidable reasons.

### What you need in Vellum

Inputs for three document texts such as clinical notes, codes, and medical necessity forms Input for plan criteria or payer policy text A step to extract and clean text from the document inputs Tools or prompts that parse notes, extract diagnosis and procedure codes, and map them to criteria Logic that checks coverage against the plan criteria and identifies missing documents or gaps A node that formats the result as structured JSON with fields like coverage (Determination, missingItems, and recommendations) An integration or trigger that runs the agent when new prior authorization packets are ready for review

## FAQ

### How does the agent handle the three documents?

It accepts clinical notes, codes, and medical necessity forms as text inputs, then extracts key details from each, such as diagnoses, procedures, and justification language.

‍

### What role does the plan criteria play?

The plan criteria or policy text is used as the standard to check coverage. The agent compares the clinical information and codes to these criteria to decide if the request appears covered, partially covered, or not covered.

‍

### What does the JSON output include?

The JSON summary can include coverage determination, a list of missing or incomplete items, relevant codes, and clear recommendations such as request additional labs, attach imaging, or provide more documentation of medical necessity.

‍

### Can it detect missing documentation or forms?

Yes. The agent looks at what the plan criteria require and compares that to what is present in the input documents, then lists missing forms, notes, tests, or codes in the missingItems section of the JSON.

‍

### How can teams use this in their workflow?

You can connect the agent to your intake process so that every prior authorization packet gets a structured review before submission. Staff can then fix missing pieces and use the JSON summary to guide what they send to the payer.

‍
