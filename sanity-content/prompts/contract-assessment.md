---
title: "Contract assessment"
slug: "contract-assessment"
metaTitle: "Contract assessment"
industry: "Legal"
---

Create an agent that reviews legal contracts against a checklist and generates risk assessments with lawyer-friendly summaries. ‍ • Inputs: &nbsp; &nbsp; - Contract PDFs &nbsp; &nbsp; - Review checklist document &nbsp; &nbsp; - Risk profile (Low / Medium / High) • Workflow: &nbsp; &nbsp; 1. ParseDocs: Extract sections from contracts and checklist items into structured JSON. &nbsp; &nbsp; 2. ClauseCheck (GPT-4.1): Compare contract clauses to checklist items, flag missing or concerning language, and summarize findings. &nbsp; &nbsp; 3. RiskAssessment (GPT-4.1): Score each flagged issue based on the provided risk profile, categorize risks (legal, financial, compliance), and propose mitigations. &nbsp; &nbsp; 4. Summary (GPT-4.1): Generate a professional legal memorandum including: &nbsp; &nbsp; &nbsp; &nbsp; - Executive summary and risk overview &nbsp; &nbsp; &nbsp; &nbsp;- Clause-level redline recommendations (CHANGE FROM / TO format) &nbsp; &nbsp; &nbsp; &nbsp; - Negotiation strategy and approval guidance • Outputs: &nbsp; &nbsp; - flagged_issues: structured JSON risk assessment &nbsp; &nbsp; - review_summary: Markdown-formatted legal summary
