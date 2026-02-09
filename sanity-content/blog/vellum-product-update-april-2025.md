---
title: "Vellum Product Update | April 2025"
slug: "vellum-product-update-april-2025"
excerpt: "We have a bunch of quality-of-life upgrades including protected tags, smoother Workflows, and more!"
metaDescription: "Vellum Product Update - April 2025"
metaTitle: "Vellum Product Update | April 2025"
publishedAt: "2025-05-01T00:00:00.000Z"
readTime: "3 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
imageAltText: "Vellum-product-update-April"
authors: ["Sharon Toh"]
category: "Product Updates"
tags: ["Evaluation", "Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1dcb3c94f2741337d43cf4a6a4537961eb83a383-716x493.png"
---

It’s spring cleaning season and we delivered - with a bunch of quality-of-life upgrades including protected tags, smoother Workflows, and bringing back some fan-favourite features, April’s updates will be sure to spark joy ✨

# 🆕 K ey New Features

### Protected Release Tags

Last month, we introduced Deployment Release Reviews to help you provide reviews on Prompts and Workflows after hitting deploy. This month, we’re adding to it with Protected Release Tags — a feature which will enforce Releases marked as “protected” to have at least one approval from a Reviewer and have zero outstanding change requests - beforeit can be assigned to a Prompt / Deployment. Useful for anyone working in critical/sensitive deployments that need more rigorous approvals before going live.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3fc9c05cfd31007ad5bea0ae286d45da4281816b-3456x1918.png)

### Dynamic Model Selection for Inline Prompts

You asked and we listened - inline prompts now accept expression inputs to represent the Model invoked in the Prompt. Previously, you were only able to statically select a model for a given Prompt Node - but now, you can use expression inputs to dynamically reference a model from an upstream Node or Workflow Input.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7afe73d54e7cb221acf60ac7634fe6f41046348f-1030x648.png)

So if you’re looking to A/B testing models, route between cost tiers, or looking to make changes to adapt to user preference, this is a great feature for you.

### Ports on Workflow Nodes

All Workflow Nodes now support Ports ! Ports act as a connector to Nodes that use branching logic and conditional execution to determine which Nodes to execute next in the workflow. Before, you had to use a separate Conditional Node to set up branching logic in your workflow. Now, every node has a “Ports” attribute that controls which path to take next, so you can simplify the number of nodes in your workflow to deliver the functionality you want.

This makes it easier to parse how data flows through your Workflow, making it easier to visually see what happens next and what logic was applied.

‍

### Grouping a Selection into a New Subworkflow Node

You can now select multiple Nodes and instantly group them into a new Subworkflow - and all existing connections will be maintained. You can even drag Nodes into existing Subworkflows, to keep things modular and tidy.

Useful as you build increasingly more complex systems to keep everything neat and tidy.

‍

### Add Node on Edge

Previously, the only way to add a Node was to drag and drop a new Node from the Nodes Panel. Now - you can now click any edge between nodes to insert a new node right into the middle of your flow. A Node selection menu will appear, allowing you to choose the type of Node and the new Node will be connected to the edge.

Building and refactoring Workflows is now much faster — especially during prototyping.

‍

### Non-Streaming Prompt Nodes

Prompt Nodes now let you choose between streaming and non-streaming execution. Non-streaming mode is ideal when parallelism matters — like with workflows that host Map Nodes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/cf9d77bca23f8d980d40581d184cff1d58452a52-1510x640.png)

### Test Suite Run Progress

Track live progress as your evaluation runs — just hover over the indicator to see how many test cases are done and how many are still moving along so you can keep tabs on progress.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/62cee8b21ec0662ada99aaf883e1d23f8d609976-706x290.png)

### Run From Node Re-enabled for SDK-Enabled Workflows

We brought back the fan-favorite Run From Node feature for SDK-enabled Workflows! Pick up execution right from any Node using a previous execution (just like before) and hit the play button which will use the “State” saved from the previous execution to run the Workflow from that point going forward. Use this feature to directly see the difference in any change that you’ve made from a specific Node onwards.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1de2bfc5dab36b3f26ae6ed491c3dc47d60ba222-2130x1164.png)

### Sandbox Cost Tracking for Workflows

You can now see how much your Subworkflows are costing — right inside the Workflow Sandbox. After a run, we’ll show you the total cost of everything triggered by your Subworkflow and Deployment Subworkflow Nodes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/98de239c0862d12d9b6829ad8fdf336147a5bfe7-426x313.png)

## 🧠 Model &amp; API Support

‍ Llama 4 models from Meta Fireworks AI: Llama 4 Scout, Llama 4 Maverick Groq: Llama 4 Scout, Llama 4 Maverick 17B Instruct

- GPT-4.1 via OpenAI GPT-4.1
- GPT-4.1 (2025-04-14) Snapshot
- GPT-4.1 Mini + Snapshot
- GPT-4.1 Nano + Snapshot
- xAI Models
- OpenAI’s newest o3
- o4 Mini
- Grok 3 Beta
- Grok 3 Fast Beta
- Grok 3 Mini Beta
- Grok 3 Mini Fast Beta
That’s all for April - we’ll back next month with a bunch of freshly cooked updates for you, but till then happy building!

See the full changelog here: https://docs.vellum.ai/changelog/2025/2025-04
