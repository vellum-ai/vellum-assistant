---
title: "MCP: The Hype vs. Reality"
slug: "mcp-the-hype-vs-reality"
excerpt: "LLMs are stepping outside the sandbox. Should you let them?"
metaDescription: "LLMs are stepping outside the sandbox with MCP. Should you let them?"
metaTitle: "MCP: The Hype vs. Reality"
publishedAt: "2025-04-09T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/7a05e8a475e59ed23f5a0e5039d6056cbd91f1d7-1232x928.png"
---

We’ve been slowly handing more control to LLMs.

First, we let them choose what to say (prompting). Then, we let them choose how to act (function calling). Next came more advanced orchestration (memory, RAG, multi-step reasoning), so they could plan and refine before they generate an output.

But all of that has stayed inside the workflow.

What if we let them go further? What if an LLM could dynamically discover and use external tools and resources through one single interface? Your CRM, your API stack, your docs in Notion, your messages in Slack?

Model Context Protocol (MCP) is a first step into that world.

An open standard designed to fundamentally change how LLMs connect to the outside world.

It’s a bold vision, but is it ready for real-world use?

# What is the Model Context Protocol (MCP)?

The Model Context Protocol (MCP) is an open protocol specification, introduced and open-sourced by Anthropic in November 2024, that standardizes the communication between LLM-powered applications and external data sources or tools.

Think of MCP as a universal adapter or a "USB-C port" for AI applications.

Just as USB-C provides a standard way to connect diverse peripherals to a computer, with power and data flowing in both directions, MCP offers a unified way for any compliant AI application (an MCP Host or Client) to interact with any compliant external resource (an MCP Server).

MCP’s main goal is to replace messy, fragile integrations with one solid, secure standard, so developers can focus on building their app, not wiring it up to every tool one by one.

It borrows the concept of standardized interactions from APIs and LSP. Like APIs standardize communication between apps, and LSP standardizes communication between IDEs and languages, MCP standardizes how AI models (like chatbots or AI agents) interact with external tools, data, and resources.

![](https://cdn.sanity.io/images/ghjnhoi4/production/955119286e1eda03c380a06047e860db4897b45c-2266x712.png)

# Why is MCP winning right now?

Last month, Swyx, an independent AI engineer said: “It’s fair to say that MCP has captured enough critical mass and momentum right now that it is already the presumptive winner of the 2023-2025 “agent open standard” wars.”

This is generally seeming like the situation we’re in, as we saw MCP trending faster than any other framework/tool on the market.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d738d91b66f0e7f0212e113fb3d3d37b38fd1f55-2554x1640.png)

Is this just another hype cycle?

What signs can we look at to determine if it’s more than that?

Well, the biggest benefit is that you only need one MCP Client to work with any MCP server. No custom integrations required.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/2fd86d9fbe919eb71f1fc5de1fd7341cba9948dc-1024x1024.png)

This means AI applications can easily connect to new tools without needing new custom connection each time. By using MCP, AI systems become more efficient and easier to scale.

Plus, it’s backed by a growing ecosystem of open-source servers and SDKs across major languages.

# Arguments against MCP

MCP is a promising but very new (just three months old). We usually recommend waiting how new tech evolves before investing too much time into it.

Although developers love the new shiny thing, there have been a few contra arguments of why this protocol might not be the best solution.

Here's where hype crashes into real-world limits:

### 1/ MCP is currently a stateful protocol

Integrating MCP with serverless AI systems is challenging because MCP relies on long-lived, stateful connections. And developers like serverless architecture for AI systems because it’s cheaper, and easier to scale.

Even the creator, Justin Spahr-Summers is aware of this limit. In their forum he explicitly says: “Deploying to a Platform-as-a-Service is really nice and convenient as a developer, so not being very compatible with this model creates an impediment to broader MCP adoption.”

### 2/ Reinventing the wheel

MCP aims to simplify how AI agents connect to tools, but most companies already use REST APIs for this. Asking server devs to build new endpoints and run long-lived servers just for MCP feels unrealistic .

Some developers are leaning towards using more lean implementations like agents-json , that formally describes contracts for API and agent interactions, built on top of the OpenAPI standard.

### 3/ Controlling AI systems in production is already hard

Managing AI in production is already very unreliable and hard. LLMs don't "understand" context in the human sense, and their interpretation of context is highly sensitive to prompt phrasing and bias. Integrating a protocol that can decide on its own on what tools/resources it can use to achieve a task is going to be very hard to evaluate and manage. So, why do we want to add more uncertainty with something that is already a high-risk?

I get the need to make space for new tech, but if you're building for production right now, it might be smarter to wait and see how this cycle plays out.

# Advice for companies serious about AI

At Vellum , we’re focused on making it easier for teams to build AI into production systems. That means helping them manage complexity, not add to it.

MCP is exciting because it promises a cleaner, standardized way for LLMs to work across tools, APIs, and workflows. It aligns with our goal of giving teams building with AI a more modular, reusable stack.

But while the vision is strong, MCP is still early.

Most enterprises don’t need full agentic autonomy across systems just yet. What they do need is control, observability , and a clear path to production. That’s why our advice today is to keep an eye on MCP, experiment if you’re curious, but don’t rebuild your stack for it just yet. The better move right now is to use battle-tested methods (like REST and webhooks) while the ecosystem matures.

If MCP lives up to its promise, we’ll be ready to support it when the time is right. And if you’re building toward that future, we’re here to help -- book a call with our experts here.
