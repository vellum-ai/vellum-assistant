---
title: "AI agent for claims review"
slug: "ai-agent-for-claims-review-and-error-detection"
shortDescription: "Review healthcare claims, detect anomalies and benchmark pricing."
heroIntroParagraph: "Analyze claims and benchmark pricing"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/50ecd3b0-3f41-42f5-9d3e-d73ce1d2fe65?releaseTag=LATEST"
workflowId: "50ecd3b0-3f41-42f5-9d3e-d73ce1d2fe65?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-09-22T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Insurance"
categoryTags: ["AI Agents"]
createdByTeam: "Ben Slade"
---

## Content

This workflow automates the review of healthcare claims to detect anomalies and benchmark pricing against established guidelines. It processes claim documents, extracts relevant data, and generates both structured JSON outputs and natural language summaries for human reviewers.

‍

## How it Works / How to Build It

TextExtractionUsingLLM : This node extracts the full text from uploaded claim documents, preserving formatting and structure. ClaimParser : Parses the extracted text to identify and categorize key elements such as CPT codes, ICD codes, charges, and provider information. SearchQueryGenerator : Generates search queries based on the parsed data to find relevant healthcare guidelines and Medicare fee schedules. GuidelinesSearch : Searches a database for relevant billing rules and standards using the generated queries. AnomalyDetection : Analyzes the parsed claim data against the guidelines to identify potential billing anomalies like upcoding or duplicate billing. BenchmarkAnalysis : Compares claim charges against regional benchmarks and Medicare fee schedules to identify pricing anomalies. JSONOutput : Generates a structured JSON analysis of the claim review findings, including parsed data, anomaly analysis, and benchmark comparisons. FinalOutputJSON : Outputs the structured JSON analysis. SummaryGenerator : Creates a natural language summary of the claim review findings for healthcare administrators. FinalOutputSummary : Outputs the natural language summary.

## What You Can Use This For

Healthcare claims auditing Identifying billing anomalies for compliance Benchmarking claim charges against industry standards Generating reports for healthcare administrators and auditors

## Prerequisites

Vellum account Access to healthcare claim documents in a compatible format (e.g., PDFs) Knowledge of relevant healthcare billing guidelines

## How to Set It Up

Create a new workflow in your Vellum account. Add the TextExtractionUsingLLM node and configure it to accept your claim documents. Connect the TextExtractionUsingLLM output to the ClaimParser node. Link the ClaimParser output to the SearchQueryGenerator node. Connect the SearchQueryGenerator output to the GuidelinesSearch node. Link the ClaimParser output to both the AnomalyDetection and BenchmarkAnalysis nodes. Connect the outputs of AnomalyDetection and BenchmarkAnalysis to the JSONOutput node. Link the JSONOutput to the FinalOutputJSON node. Connect the outputs of AnomalyDetection and BenchmarkAnalysis to the SummaryGenerator node. Link the SummaryGenerator to the FinalOutputSummary node.

‍
