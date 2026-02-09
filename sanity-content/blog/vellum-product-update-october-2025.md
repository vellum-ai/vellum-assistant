---
title: "Vellum Product Update | October"
slug: "vellum-product-update-october-2025"
excerpt: "Native integrations, Agent Builder Threads, and upgrades that make agent building faster than ever in Vellum."
metaDescription: "Native integrations, Agent Builder Threads, and upgrades that make agent building faster than ever in Vellum."
metaTitle: "Vellum Product Update | October 2025"
publishedAt: "2025-11-05T00:00:00.000Z"
readTime: "7 min"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
reviewedBy: "Nicolas Zeeb"
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/814c2242174cafd2d587db346f877b3f1462982f-320x200.png"
---

The only thing we’re more thankful for than coding agents this November is everything our engineers shipped to Vellum in October.

This month’s updates make building in Vellum faster and smoother than ever, with big improvements to Agent Builder including native integrations, auto-generated agent tools, and better deployment visibility.

We’ve got plenty more improvements packed in, so let’s dive right in!

## New Features

### Native Integrations

Vellum now has 35+ native integrations and counting! What used to require a fragmented Composio setup or manual API configuration can now be done directly in Vellum.

Authenticate and manage third‑party integrations directly in the platform to use them inside Agent and Custom Nodes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d055d7bf40c212ce3fce31572be6eceee6e96376-3222x1002.webp)

These native integrations let you seamlessly connect your agents to your everyday tools like Slack, Notion, HubSpot, and Airtable, so your Workflows can send messages, fetch data, or update records without any manual setup.

You can set up your integrations by interacting with Agent Builder, or manually by Settings &gt; Integrations .

### Agent Builder Threads

Agent Builder Threads are now generally available!

Threads save and organize your conversations in Agent Builder, so you can leave and come back to previous conversations without losing progress or create multiple threads to separate different ideas or tests.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8f88d131050b7a207b8e0e07bc54504d0cfd03dd-694x210.webp)

These threads make it easy to stay organized in Agent Builder. You can keep one thread focused on debugging a Workflow while using another to iterate on a new agent, each with its own conversation history you can pick up anytime.

# Agent Builder Improvements

### Agent Builder Generates Agent Nodes with Integration Tools

Agent Builder can now automatically create Agent Nodes with the right integration tools when you ask it to use integrations in your Workflow. It configures the required tools and API calls for you, so you can go from intent to a callable node in one step.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/00685a1a1c29301d47e50c52e0a70ad075a7f9b5-889x1183.webp)

If a native integration isn’t supported yet, Agent Builder can still generate a functional custom tool using Python, Agent handoffs, Inline Subworkflows, or version-controlled Deployed Subworkflows.

This makes it lightening fast to use Agent Builder to integrate your necessary tools and data systems and build complex automation without needing to manually configure tools or write custom code for every tool call.

### Documents and Document Index Improvements

Managing files and indexes while building agents is no longer disconnected from the Workflow sandbox.

Agent Builder now includes superior document handling, letting you to create and view files in Document Indexes without leaving your build.

This makes it easier to design, debug, and refine document retrieval steps without leaving your Workflow sandbox.

Say you’re building a RAG support agent that needs to reference onboarding guides or help articles, you can now upload those documents, create a Document Index, and connect it to your Workflow all from Agent Builder.

### Deployment Node Support

Agent Builder now supports Prompt Deployment Nodes and Workflow Deployment Nodes, letting you add version-controlled Prompts and Workflows directly into the builds you create.

This makes it easy to use Agent Builder to integrate tested releases and build more advanced systems without leaving your Workflow.

For example, if you’ve already deployed a Workflow that handles lead qualification, you can ask Agent Builder to use that deployment inside a new Workflow for outreach. It will automatically reference the version-controlled Workflow, so you can reuse trusted logic without rebuilding it from scratch.

# Feature &amp; Product Improvements

### Release Page Artifacts

Each Workflow Deployment Release now includes a view of the exact code representation behind that release, the same code your CLI pulls and production runs.

This lets you inspect what’s actually deployed, line by line, so you can confirm changes, debug issues, and trust that what’s live matches what you built.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6a8799828c06c011d0e2532d82299d9989b683d2-1593x444.webp)

For example, if a Workflow starts returning unexpected outputs after deployment, you can open its release page and view the exact code representation for that version to quickly compare it with previous releases, spot what changed, and debug without switching between your CLI and the UI.

### Simplified Deployment URLs

Deployment URLs have been simplified by using only the Deployment ID or name in the link.

Before: /workflow-sandboxes/&lt;sandbox-id&gt;/deployments/&lt;deployment-id&gt;

After: /workflow-deployments/&lt;deployment-id&gt;

This makes it easier to reference deployments from your external systems and link back to Vellum. This also gives you the ability to use a deployment’s name instead of its ID to keep URLs cleaner and more readable.

Not to panic, older links will continue to work and automatically redirect.

### Settings Revamp

Models, integrations, and personal settings are no longer spread across different pages. The Settings Menu has been revamped and moved intuitively under your profile icon in the top right.

Models and integrations now live under Settings, while your personal profile and preferences have moved to the avatar menu.

This makes navigation simpler and setup faster, so you can manage your workspace and personal settings all in one place.

## New Model Support

OpenAI

GPT‑5 Pro Modes GPT 5 Pro GPT 5 Pro (2025-10-06)

Anthropic

Claude Haiku 4.5

‍

That’s a wrap for October.

Agent Builder really leveled up this month. It’s now faster at understanding what you need, smarter about how it builds, and more connected to the tools you already use. Jump back into Vellum, try the new flow, and see how much smoother it feels to bring your agents to life. Please reach out with any feedback, we’d love to hear it!
