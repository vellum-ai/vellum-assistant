---
title: "Vellum Product Update | March 2025"
slug: "vellum-product-update-march-2025"
excerpt: "Our biggest product feature drop ever: 27 updates in a single month (a Vellum record!)"
metaDescription: "Vellum Product Update - March 2025 - Prompt Diffing and real-time monitoring integrations to GA of our Workflows SDK and PDF inputs"
metaTitle: "Vellum Product Update | March 2025"
publishedAt: "2025-04-04T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
imageAltText: "Vellum-product-update-March"
authors: ["Sharon Toh"]
category: "Product Updates"
tags: ["Evaluation", "Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1dcb3c94f2741337d43cf4a6a4537961eb83a383-716x493.png"
---

🌸 Spring has sprung, and with it, our biggest feature drop ever : 27 updates in a single month (a Vellum record! 🚢). From Prompt Diffing and real-time monitoring integrations to GA of our Workflows SDK and PDF inputs, March was packed with upgrades to help you build, test, and ship faster than ever.

Let’s dig into what’s new.

## 🆕 Key New Features

### Prompt Comparison / Diffing

This one’s been at the top of many of our customers' wishlist — and it’s finally here. You can now view side-by-side diffs between prompt versions, so you never have to guess what changed again.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/c4a19023bdc0b4e6ef0c917dfa47b4c8d4a699a3-2048x1137.webp)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3731d5df7aa1d9bd01cdc3208ca3c23d8364999f-3456x1916.png)

Whether you’re reviewing edits, debugging issues, or approving updates before deployment, this highly requested feature gives you full visibility into every change, line by line.

### Deployment Release Reviews

Inspired by GitHub PR reviews, this feature allows team members to review, approve, or request changes to Prompt and Workflow Deployments. Perfect for Enterprise teams that require a formal approval process comply&nbsp;with SOC 2 regulations. Watch Noa break it down:

### Native Retry &amp; Try functionality

You can now “wrap” any node with Try or Retry Adornments directly from the side panel — giving you first-class error handling.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/2447fab9b18a14307cc0d8582297c1588ce532da-1108x1394.png)

Retry will keep invoking the wrapped node until it succeeds (or hits the max attempts). Try will attempt once and continue gracefully even if it fails.

Bonus: these show up cleanly in your monitoring view, just like a single-node Sub-workflow.

### Monitoring View Overhaul

For our VPC and self-hosted customers — this update is for you! With a brand new Grafana-based implementation, the revamped Monitoring View offers faster load times, smoother zooming, and better filters for things like date ranges and Release Tags. It’s everything you need to analyze performance at scale, now wherever you're deployed.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4ed95d03a4b78636d329a5bcec7beb3b605db825-3456x1986.png)

### Webhooks + Datadog Integration

You can now configure Webhooks to receive real-time Vellum event updates — perfect for syncing with external tools like a data warehouse or custom health dashboard.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/53a981e98e24d37ac7253194de64bcbdd7d6cfbe-1234x902.png)

You can emit those same Vellum events in near-real-time to Datadog for deeper observability!

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/08cd68c95acfda15530328dd601e484389e105f3-1222x890.png)

### Workflows SDK General Availability

All newly created Workflows are now SDK-enabled by default! Vellum Workflows SDK makes it easier to build predictable AI systems and collaborate with nontechnical teammates by allowing you to build your AI Workflows in code or in UI. Changes are synchronized by pushing and pulling between code and UI. Try our 5 minute quickstart .

### PDFs as a Prompt Input

You can now pass PDFs directly into Prompts — perfect for extracting structured data from documents and powering downstream workflows. Just drag and drop a PDF into a Chat History variable , and if the model supports it (like Anthropic’s), you’re good to go. It’s like multi-modal inputs… but for documents.

Since PDFs are handled as images under the hood, this pairs perfectly with Vellum’s support for image inputs . Vellum supports images for OpenAI’s vision models like GPT-4 Turbo with Vision — both via API and in the UI. Read more about it here .

### Workflow Deployment Executions – Cost Column

You’ll now see a Cost column in the Workflow Deployment Executions view — helping you track compute spend at a glance. This column breaks down the total cost per execution , summing up all Prompt invocations — so you get a clear picture of what’s driving spend across each run.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9bc807bb8a13a1c2a5b85f61bae30287cd1b5d87-2074x940.png)

## 🔧 Quality of Life Improvements

### Global Search

You can now search across all your Prompts, Workflows, Document Indexes, and more with Global Search.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ff7ab86c101dac3745980406c421ee9bd53fc23c-528x900.png)

This long-awaited feature lets you quickly find and jump to any resource in your Workspace — no more clicking around to track things down.

### New Workflow Deployment APIs

You can now use two new APIs to List Workflow Deployment Executions for a specific Workflow Deployment or Retrieve Workflow Deployment Execution for any single execution — making it easier to programmatically track and analyze Workflow runs outside of Vellum.

### Automatic Evaluations Setup

Vellum now auto-generates a Test Suite with one Test Case per Scenario the first time you visit the Evaluations tab, so you can start adding Metrics and Ground Truth instantly.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4c5e17b6e8cf3ed211ad1236435329889118210f-3456x1918.png)

## 🧠 Model &amp; API Support

Gemini 2.5 Pro Model Support Added support for Gemini 2.5 Pro Experimental (03-25 version) Supports 1M input token context window and 64k output tokens via Google’s Gemini API

- LLaMa 3.3 70B via Cerebras Added support for LLaMa 3.3 70B through Cerebras AI
- Qwen QwQ Models via Groq Added support for: QwQ 32B
- QwQ 2.5 Coder 32B
- QwQ 2.5 32B
- All via Groq’s preview models
- Qwen QwQ 32B via Fireworks AI Added support for Qwen QwQ 32B through Fireworks AI
- PDF Support for Gemini 2.0 Flash Models Drag-and-drop PDF support added for: Gemini 2.0 Flash Experimental
- Gemini 2.0 Flash Experimental Thinking Mode
- Gemini 2.0 Flash
That’s a wrap on March! From fresh debugging views to friendlier editors and deeper integrations, this month was all about helping you move faster with more clarity. We’ll be back in April with even more. Until then — happy building! 🚀

Changelog: https://docs.vellum.ai/changelog/2025/2025-03
