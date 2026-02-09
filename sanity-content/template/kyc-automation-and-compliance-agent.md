---
title: "KYC compliance agent"
slug: "kyc-automation-and-compliance-agent"
shortDescription: "Automates KYC checks by reviewing customer documents stored in HubSpot"
heroIntroParagraph: "Automate KYC checks and send reports to Slack"
prompt: "Create an agent that automates “Know Your Customer” (KYC) checks. Look atcustomer-uploaded documents in Hubspot. Verify document validity, completeness, and expiry. Flag missing or inconsistent information and recommend follow-up actions. Output a compliance summary and send a report via gmail. Send a report to internal Slack channel (i will provide it)"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Finance"
categoryTags: ["AI Agents"]
createdByTeam: "Anita Kirkovska"
integrations: [" Slack", "Gmail", " Hubspot"]
---

## Prompt

Create an agent that automates “Know Your Customer” (KYC) checks. Look at customer-uploaded documents in {{Hubspot}}. Verify document validity, completeness, and expiry. Flag missing or inconsistent information and recommend follow-up actions. Output a compliance summary and send a report via {{Gmail}}. Send a report to internal {{Slack}} channel (i will provide it).

## Content

### Why you need it

‍ Manual KYC checks are slow and easy to mess up. Someone has to collect documents, confirm they are valid, not expired, match the customer, and meet policy. Details like mismatched addresses or missing pages can slip through until an audit or regulator asks questions. This agent reviews KYC documents for you. It checks ID, proof of address, and corporate certificates for validity, completeness, and expiry, flags missing or inconsistent information, and recommends next steps. It then sends a clear compliance summary by email and posts a report to an internal Slack channel you provide, so your team stays aligned and everything is logged.

‍

### What you need in Vellum

HubSpot integration with access to contacts or companies and attached documents Logic to fetch customer uploaded documents from HubSpot for review Parsing or OCR step if documents need text extraction Rules to check document type coverage such as ID, proof of address, corporate docs Rules to validate completeness and expiry dates Logic to detect inconsistent information such as name or address mismatches A compliance summary template with status, findings, and follow up recommendations Gmail integration to send the report to a compliance or operations inbox Slack integration with an input for the internal channel ID A trigger such as on new document upload, stage change, or scheduled daily batch

## FAQ

### How does the agent find documents in HubSpot?

It reads customer records in HubSpot and looks for attached files or document fields that hold KYC documents. For each contact or company, it pulls the linked documents into the review flow.

‍

### What checks does it perform on each document?

It checks if the document type is present, if the content is readable, if required fields like name and address are visible, and if the expiry date has passed or is close. It can also confirm that details match what is stored in HubSpot.

‍

### How does it handle missing or inconsistent data?

The agent flags missing document types, expired IDs, or mismatched fields such as different addresses across documents. It then recommends follow up actions like request updated ID, ask for recent proof of address, or clarify company details.

‍

### What is in the compliance summary and reports?

The compliance summary includes an overall KYC status, list of documents reviewed, issues found, and recommended next steps. The agent emails this summary using Gmail and posts a shorter version into the internal Slack channel you provide so the team can see the result quickly.

‍

### Can we adjust the KYC rules to fit our policy?

Yes. You can change which document types are required, expiry thresholds, allowed address differences, and how strict the agent should be. This lets you align the checks with your internal KYC policy and local regulations.
