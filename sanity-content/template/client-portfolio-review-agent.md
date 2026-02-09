---
title: "Client portfolio review agent"
slug: "client-portfolio-review-agent"
shortDescription: "Compiles weekly portfolio summaries from PDFs, highlights performance and risk, builds a Gamma presentation deck."
heroIntroParagraph: "Summarize my clients’ portfolios weekly"
prompt: "Create an agent that compiles a weekly summary of each client’s investment portfolio.‍• Pull holdings, performance, and benchmark data from a PDF file upload that I will provide as input• Highlight top-performing assets, risk exposure, and allocation drift.• Generate personalized summaries for advisors to share with clients.• Generate a 5 page slides in Gamma using the context from the agent• Send the slides to my clients (I'll provide the emails) "
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Finance"
categoryTags: ["AI Agents", "Document extraction"]
createdByTeam: "Anita Kirkovska"
integrations: ["Gmail", "Gamma", "Vector db"]
---

## Prompt

Create an agent that compiles a weekly summary of each client’s investment portfolio. Pull holdings, performance, and benchmark data from a PDF. Then generate a summary for top performing assets, risk exposure and allocation drift. Using this summary generate a 5 page slide {{Gamma}} presentation. Send the slides to my clients (I'll provide their emails).

## Content

### Why you need it ‍

Weekly portfolio updates are important but slow. You have to read PDFs, pull out holdings and performance, write a summary, build slides, and then email everything to each client. This agent does that for you. It reads the portfolio PDF, pulls holdings, performance, and benchmark data, highlights top performers, risk exposure, and allocation drift, then generates a clean summary for advisors to share. It also creates a 5 page slide deck in Gamma using the same context and sends the finished slides to each client using the email addresses you provide.

### What you need in Vellum

Input for portfolio PDF uploads Parsing step to extract holdings, performance, and benchmark data Logic to identify top performing assets, risk exposure, and allocation drift Template to generate personalized text summaries for each client Integration or API call to create a 5 slide Gamma presentation from the agent output Input field for client email addresses Email sending step that attaches or links the Gamma deck and includes the summary Weekly trigger or manual run after new PDFs are availableil

## FAQ

### How does the agent use the PDF input?

It reads the PDF you upload, extracts tables and sections with holdings, performance, and benchmarks, and turns that into structured data for analysis and reporting.

‍

### What does the client summary include?

The summary covers overall performance, top and bottom performers, current allocation, risk exposure, and any drift from the target allocation, written in simple language that advisors can send directly or lightly edit.

‍

### What is in the 5 slide Gamma deck?

The deck can include a title slide, performance overview, top holdings, risk and allocation view, and a closing slide with advisor notes or next steps, all based on the same data the agent used for the text summary.

‍

### How does the agent send the slides to clients?

You provide client email addresses as input. Once the Gamma deck is created, the agent sends an email to each client that includes the deck link or attachment together with the summary text.

‍

### Can I customize the summary and slide style?

Yes. You can adjust prompts and templates to match your firm’s tone, branding, and preferred slide layout, and update the content structure without changing the core workflow.
