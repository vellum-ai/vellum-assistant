---
title: "M&A due diligence"
slug: "m-a-due-diligence"
metaTitle: "M&A due diligence"
industry: "Legal"
---

Create an agent that automates the first-pass review for M&amp;A due diligence by analyzing all documents in a target company’s data room. • Inputs: &nbsp; &nbsp; - Contract and policy PDFs &nbsp; &nbsp; - Litigation summaries or filings &nbsp; &nbsp; - Due diligence checklist (Markdown or Notion) • Workflow: &nbsp; &nbsp; 1. Ingest Node: Parse all uploaded materials and categorize them by type (corporate, IP, HR, litigation, compliance). &nbsp; &nbsp; 2. Checklist Node (GPT-4.1): Match documents to checklist items, flag missing or incomplete sections, and extract key issues. &nbsp; &nbsp; 3. Risk Node (GPT-4.1): Score issues by severity (High / Medium / Low) and classify them by area (legal, financial, operational). &nbsp; &nbsp; 4. Summary Node: Generate a Markdown diligence summary with: &nbsp; &nbsp; &nbsp; &nbsp; ▪ Executive overview of top risks &nbsp; &nbsp; &nbsp; &nbsp; ▪ Section-by-section issue list &nbsp; &nbsp; &nbsp; &nbsp; ▪ Follow-up questions for counsel &nbsp; &nbsp; &nbsp; &nbsp; ▪ Recommended next steps for negotiation • Outputs: &nbsp; &nbsp; - issues_log: JSON of findings and risk levels &nbsp; &nbsp;

- due_diligence_summary: Markdown review for legal and deal teams
