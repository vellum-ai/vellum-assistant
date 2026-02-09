---
title: "Negotiation summarizer"
slug: "negotiation-summarizer"
metaTitle: "Negotiation summarizer"
industry: "Legal"
---

Create an agent that compares negotiation drafts from multiple counterparties (e.g., customer legal, procurement, vendor) to highlight open issues and positions. • Inputs: &nbsp; &nbsp; - Multiple contract versions (e.g., Round 1, Round 2, Final) • Workflow: &nbsp; 1. DiffNode: Detect redlines and changes across all drafts. &nbsp; &nbsp; 2. IssueExtractor (GPT-4.1): Group edits by issue type (payment terms, IP, governing law, etc.). &nbsp; &nbsp; 3. PositionAnalyzer: Determine stance alignment (Accepted / Pending / Countered) across parties. &nbsp; &nbsp; 4. Summary Node: Output a Negotiation Dashboard summarizing: &nbsp; &nbsp; &nbsp; &nbsp; - Open issues with owner &amp; last edit date &nbsp; &nbsp; &nbsp; &nbsp; - Convergence percentage over time &nbsp; &nbsp; &nbsp; &nbsp; - Recommended next steps for each stakeholder &nbsp; &nbsp; 5. SheetUpdater: Create a new Google Sheet summarizing open issues and next steps for each stakeholder • Outputs: &nbsp; &nbsp; - negotiation_issues: JSON issue log &nbsp; &nbsp; - Entry in Google Sheet
