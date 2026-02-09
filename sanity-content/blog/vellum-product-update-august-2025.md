---
title: "Vellum Product Update | August"
slug: "vellum-product-update-august-2025"
excerpt: "MCP-powered Agent Nodes, public Workflow sharing, and a new Workflow Console for easier, collaborative building."
metaDescription: "MCP-powered Agent Nodes, public Workflow sharing, and a new Workflow Console for easier, collaborative building on Vellum."
metaTitle: "Vellum Product Update | August"
publishedAt: "2025-09-03T00:00:00.000Z"
readTime: "6 min"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/79a805d20d7cac9bc7143f57e02bfa9d097ad3bb-1399x874.heif"
---

With September starting to cool us down, Vellum is still heating up from August updates.

This month we focused on empowering our builders by integrating MCP into Agent Nodes, making all Workflows shareable, and added a brand‑new sandbox console to make building cleaner and easier than before.

With plenty more features and UX updates, let’s get into it!

## MCP in Agent Node

Agent nodes used to limited to custom connections with external tools.

With MCP enabled in the Agent Node, you can now connect your Agent Node to MCP servers and Vellum will automatically discover and execute available tools.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/27c06a3d284febe8c5f404665ef2b661715a643a-1652x800.png)

With MCP support, Agent nodes can dynamically discover and expose every tool from a connected MCP server, eliminating the need for one-off API connectors.

This standardization cuts boilerplate integration code, ensuring agents across different workflows can reliably call the same toolset with consistent parameters and behaviors.

## Workflow Console

Debugging workflows used to mean tedious clicking between nodes to piece together what happened.

To reduce this friction and make complex workflow management simpler, we’ve introduced a Workflow Console.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/57d15d34fc50d4e52c4a1cc741666295be21feb4-2980x1824.png)

Workflow Console is equipped with:

Logs that show the chronological timeline view of workflow executions including latency Panel view that shows the inputs and outputs of any executed node

This makes it far easier to debug and monitor complex Workflow executions, giving you a clear top-down view of each branch, retry, and reasoning step without clicks or extra reruns.

## Workflow sharing

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/296a635524f89a516b18f0445736d866599a45dd-992x924.png)

Sharing workflows used to only happened at the team level.

Now, you can make your workflows public to:

share on social media embed an iframe on your website share to Vellum community for others to clone and use for themselves

Every workflows ca now become a reusable assets beyond its value to your immediate team.

# Workflows

## Editable Code Preview Files

Previewing code used to mean running ‘vellum workflows pull’ to edit your code then doing a ‘vellum workflow push’ to update workflow code.

Now editing and previewing code can all be done in Vellum with Editable Code Preview Files.

Toggling Edit Mode enables direct edits and file modification in the Code Preview UI, giving you greater code control without using low code UI.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/464b5ad808bf443f8e3edf790d4883f991e19c32-502x298.png)

## Workflow Canvas Collapse Toggle

Complex canvases could feel crowded, and sharing a tidy view wasn’t possible.

Now you have the option to quick collapse/expand nodes within the workflow with a toggle switch.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/502552077fdfe50291eb77c4ef287ba2cd9c05e0-2710x708.png)

## Updated Node Handles

Node Handles used to be too visually complex.

Node Handles now include a new plus icon, improved edge dropping, and visual states for incoming edges:

Nodes with 0 incoming edges Nodes with 1 incoming edge Nodes with 2+ incoming edges

These cleaner connection structures reduces visual noise while giving you greater visibility into workflow scaffolding at a glance.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/07d1425b6b734bda52520c8cabd5ce470ed1d210-1866x1054.png)

# New Model Support

We added support for:

OpenAI GPT‑5 family (GPT‑5, Mini, Nano) via Chat Completions and Responses APIs OpenAI GPT‑OSS 120B and 20B GPT‑OSS 120B on Cerebras GPT‑OSS 120B and 20B on Groq Anthropic Claude Opus 4.1 Cerebras Qwen 3 480B (Coder, Thinking, Instruct) Vertex AI Gemini 2.5 Flash lite finetuned models

More options to enable you to build the most efficient workflows.

# Quality of Life improvements

## Updated Insert Node Panel

Finding and adding nodes within workflows used to be more manual and tedious, so we re-designed the panel to make it quicker to find and add nodes.

Key improvements include:

Search Bar : Quickly find specific nodes by typing their name Updated Copy : Clearer, more concise descriptions for each node type Smaller Cards : More compact design that fits more nodes on screen Reorganized Layout : Better categorization with logical groupings Nested Hierarchy : Expandable sections for Control Flow and other categories

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1e56cd54cf71b975295236b2cd9244c7adab83fc-1218x1366.png)

## Revamped Model Page

Our older model page included too much visual noise making it hard to find the models you wanted to manager.

We gave it a makeover with a cleaner interface that houses models by provider.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d7a631fa23ecfb96f69a49902e71e62d9f2f58bc-3414x1654.png)

## Improved Variable Detection

Previously, when you pasted prompts with {{ variable }} placeholders into Rich Text inputs, any undefined variables were treated as plain text instead of being recognized.

With this update, Vellum now automatically creates those variables and displays them as chips.

This makes it much easier to copy and paste prompts directly from your codebase or other tools without extra setup, speeding up workflow building.

## See you in October!

From adding video inputs and workflow sharing to improving agent tools and the model management experience, August was all about faster iteration with deeper capabilities and smoother UX. September will bring even more exciting features to builders and collaborators alike. As always, we’d love your feedback—let us know what you think and what you’d like to see next!
