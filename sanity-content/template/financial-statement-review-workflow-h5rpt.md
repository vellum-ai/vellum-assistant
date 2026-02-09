---
title: "Financial Statement Review Workflow"
slug: "financial-statement-review-workflow-h5rpt"
shortDescription: "Extract and review financial statements and their corresponding footnotes from SEC 10-K filings."
heroIntroParagraph: "Extract and review SEC 10-Ks documents"
onboardingUrl: "http://app.vellum.ai/onboarding/open-in-vellum/18479f2e-6acc-47de-ac0f-62667e18029d?releaseTag=LATEST"
workflowId: "18479f2e-6acc-47de-ac0f-62667e18029d"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Finance"
categoryTags: ["Document extraction", "Data extraction", "Evaluation"]
createdByTeam: "Anita Kirkovska"
---

## Content

This agent extracts and reviews financial statements and their corresponding footnotes from SEC 10-K filings. It identifies major financial statement tables and verifies the accuracy and completeness of footnotes, ensuring compliance with U.S. GAAP and SEC regulations.

‍

### How it Works / How to Build It

FinancialSectionExtractor : This node uses a prompt to extract major financial statement tables from the 10-K filing text, outputting them as a structured JSON object. SectionExtractor : This node extracts the "Notes to the Financial Statements" section, capturing each footnote's number, title, and full text in a JSON format. ExtractFootnotes : This node takes the output from the SectionExtractor and formats the extracted footnotes into a JSON object for further processing. IterateOverEachFootnote : This node iterates over each extracted footnote, triggering a sub-workflow to verify the accuracy and completeness of each footnote against the financial statements. FinalOutput : This node compiles the results from the footnote verification process and outputs the final structured data.

### What You Can Use This For

Financial auditing teams can use this workflow to automate the extraction and review of financial statements and footnotes. Compliance officers can ensure that financial disclosures meet regulatory standards. Analysts can quickly gather and analyze financial data from 10-K filings for reporting or research purposes.

### Prerequisites

Vellum account Access to SEC 10-K filing documents in text format Basic understanding of financial statements and footnotes

### How to Set It Up

Clone the workflow template in your Vellum account. Upload your SEC 10-K filing documents as input. Configure the Inputs to include the chat history for context. Connect the nodes in the specified order: FinancialSectionExtractor &gt;&gt; SectionExtractor &gt;&gt; ExtractFootnotes &gt;&gt; IterateOverEachFootnote &gt;&gt; FinalOutput . Run the workflow to extract and review the financial statements and footnotes.
