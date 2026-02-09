---
title: "Legal contract review AI agent"
slug: "legal-contract-review-ai-agent"
shortDescription: "Asses legal contracts and check for required classes, asses risk and generate report."
heroIntroParagraph: "Assess contracts and risk and generate a report"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/f2dfa6df-fbde-4d50-9d6d-df35dab6f233?releaseTag=LATEST"
workflowId: "f2dfa6df-fbde-4d50-9d6d-df35dab6f233?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-10-14T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Legal"
categoryTags: ["AI Agents", "Data extraction", "Document extraction"]
createdByTeam: "Nicolas Zeeb"
---

## Content

This AI agent workflow automates the assessment of legal contracts by parsing them, checking for required clauses, assessing risks, and generating a summary report. It helps legal teams quickly identify potential issues in contracts and provides actionable insights.

‍

## How it Works / How to Build It

Parse Docs : This node takes in contract documents and a review checklist, normalizing the contracts into structured text with section IDs. It outputs a list of normalized contracts and checklist items. Clause Check : This node analyzes the parsed contracts against the review checklist, identifying missing or variant clauses. It returns a JSON object detailing the status of each clause. Risk Assessment : This node evaluates the flagged issues from the ClauseCheck against a specified risk profile. It assigns risk scores and provides justifications and mitigation actions for each issue. Summary : This node generates a comprehensive, lawyer-friendly summary of the contract review, including executive summaries, risk analyses, critical issues, redline recommendations, and negotiation strategies. Final Output Flagged Issues : This node outputs the JSON data of flagged issues identified during the ClauseCheck. Final Output Review Summary : This node outputs the lawyer-friendly review summary in Markdown format.

## What You Can Use This For

Contract review and compliance checks for legal teams. Risk assessment for potential legal issues in contracts. Generating summaries for executive reviews and negotiations. Identifying missing or variant clauses in legal documents.

## Prerequisites

Vellum account. Contracts in a compatible format (e.g., PDF, Word). A review checklist document outlining required clauses. A defined risk profile for assessment.

## How to Set It Up

Create a new workflow in your Vellum account. Add the Parse Docs node and configure it to accept your contracts and review checklist. Connect the Parse Docs output to the Clause Check node. Connect the Clause Check output to the Risk Assessment node. Connect the Risk Assessment output to the Summary node. Connect the Summary output to both Final Output Flagged Issues and Final Output Review Summary nodes. Configure the inputs for each node as needed, ensuring the risk profile is set for the Risk Assessment node. Test the workflow with sample contracts to ensure it functions as expected.

## FAQ

#### 1. Can I customize the checklist or risk profile for different contract types?

Yes. The Clause Check and Risk Assessment nodes are both prompt- and data-driven, meaning you can update the review checklist or adjust the risk thresholds to match NDAs, vendor agreements, or partnership contracts. This makes the workflow reusable across multiple review frameworks.

#### 2. How does the agent determine the severity of risks it flags?

The Risk Assessment node uses your defined risk profile to evaluate each issue based on context like missing indemnity clauses or altered liability terms. Each flagged item is scored and explained, helping reviewers quickly distinguish between minor deviations and high-risk contract terms.

#### 3. What’s the best way to validate the results before finalizing a review?

You can set up a human validation step by adding a Reviewer Approval node or using Vellum’s human-in-the-loop functionality. This ensures flagged issues are reviewed by a legal team member before summaries are finalized or sent to external stakeholders.

#### 4. Can I generate different types of summaries for different audiences?

Definitely. The Summary node’s prompt can be modified to produce versions tailored for executives, clients, or internal counsel, like a high-level summary with risk highlights or a detailed redline-ready report. You can also export outputs in Markdown, HTML, or JSON formats.

#### 5. How could I extend this workflow beyond contract reviews?

The same structure works for policy compliance checks, due diligence reviews, or internal risk audits. By changing the checklist inputs and document sources, this becomes a general-purpose document evaluation agent for any domain requiring structured review and reasoning.
