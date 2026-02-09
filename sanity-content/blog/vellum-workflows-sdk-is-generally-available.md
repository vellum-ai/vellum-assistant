---
title: "Vellum Workflows SDK is Generally Available"
slug: "vellum-workflows-sdk-is-generally-available"
excerpt: "Full control in code and real-time visibility in UI, built for teams shipping reliable AI."
metaDescription: "Full control in code and real-time visibility in UI, built for teams shipping reliable AI."
metaTitle: "Vellum Workflows SDK is Generally Available"
publishedAt: "2025-07-14T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Akash Sharma"]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/707190358250f7dfe388a2265182cbf7ef63f364-2099x1311.png"
---

tldr: Today we’re GA’ing Workflows SDK – an expressive framework for defining agentic systems. Coupled with a CLI for bi-directionally syncing edits to and from our UI, Workflows SDK helps developers rapidly define, debug, and iterate on AI systems. You can collaborate with non-technical stakeholders in a UI, while maintaining full control in code. Check out the demo video here . Also, it’s open source and free to try !

## A new framework for AI Engineering

Today’s AI systems require orchestration across LLMs, tools, vector databases, and business logic, all while balancing flexibility, control and transparency.

We’ve seen the rise and fall of many AI frameworks over the past few years, they seem magical at launch but lose popularity over time. The very same abstractions that make it easy to get started prevent engineers from going to production reliably. We noticed a gap in the market, with nothing delivering what AI Engineers were actually looking for.

There were two guiding principles we followed while developing Workflows SDK:

( i) Developers need to feel in control of the AI systems they build. We think AI systems are best modeled as graphs &amp; our declarative, type-safe syntax allows developers to clearly understand how information flows through each step of their AI application. Built-in type safety flags issues before runtime, resulting in a more robust and predictable final AI product.

(ii) A UI to visualize and edit the graph plays an essential role in AI development. Akin to the “hot reload” paradigm found in frontend development, AI Engineers benefit from being able to clearly see the inputs and outputs at each step of the graph to debug and make tweaks along the way. The UI also brings in cross-functional stakeholders to the AI development process — non-technical team members can iterate on prompts, control flow and evals, often allowing the whole team to move faster.

That’s why we built Vellum Workflows SDK – an expressive framework that helps you define AI systems as graphs. With an integration between code and our Workflows UI, Workflows SDK provides both developers and their stakeholders the tools they need to collaborate and build reliable AI systems quickly.

Here’s a quick demo of the highlights before we dive into the details:

## Key Features of Workflows SDK

Declarative Graph Syntax

‍ Define your AI systems as clear, self‑documenting graphs: nodes represent tasks, edges define control flow, and both loops and conditionals are supported with built-in type safety. You get predictable logic and superior debugging out of the box.

Locally executable

The SDK acts as the definition and execution layer of your AI agents. The code is executable locally with some nodes making round-trips to Vellum servers. Coming soon, all nodes will be directly executable locally and monitoring data can be emitted back to Vellum.

Code-First, UI-Native

Bi-directional syncing between code and UI ensures flexibility for engineers while making workflows accessible to non-technical collaborators.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/2776e08bfbe2dcddbc97f8f5fe3dcce5514a8c26-1920x1080.heif)

Powerful Debugging Tools

Track inputs, outputs, and state changes at each node both in code and UI. Type-safety flags errors at compile time.

Streaming

Native support for streaming, at both the Workflow level and the Node level. Return incremental values as a final output, or stream results between nodes in real time.

State Management

Nodes read from and write to the graph’s global state, which can be used to share information between nodes without defining explicit inputs and outputs.

Human-in-the-loop

Nodes can wait for External Inputs, allowing for a pause in the Workflow until a human or external system provides input.

Advanced Control Flow

Our simplified syntax under-the-hood manages the orchestration of parallel branches, looping, state forking and asynchronous behavior.

Smart defaults to start, flexibility where you need

Use out-of-box Nodes for common AI operations: invoke Prompts, call Tools, perform RAG, and more. Define your own custom Nodes using the same primitives used by Vellum's Nodes.

Custom Docker Runtimes for Advanced Use Cases

Bring in your own code with custom Docker runtimes, sandboxed securely and visually represented in the UI. Central AI Engineering teams can create custom nodes for their less-technical counterparts and other teams to use easily for their own projects. Coming soon are custom UI components for these nodes.

## Built for Developers, Designed for Teams

With Workflows SDK, your AI system’s definition and execution live in the same layer. That means:

Engineers can rapidly prototype, debug, and iterate on AI systems with full visibility. Teams can collaborate across technical and non-technical roles, getting faster time to market. AI products get built faster with tight integration across orchestration, evaluations and monitoring

## Getting started

Vellum Workflows SDK is Generally Available today. It's free to try, open source, and production-ready. Whether you’re experimenting with a new agent architecture or bringing a mission-critical AI use case to life, Workflows SDK gives you the control, flexibility, and visibility you need.

To get started with the Vellum SDK you have two options.

(i) Build Workflows in code, push to UI

The Vellum Workflows SDK lets you build agentic workflows in Python using starter templates like Prompt Chaining. You define logic with modular nodes, test locally with sandbox.py , and connect everything in workflow.py . When it’s ready, push your workflow to the Vellum UI for debugging, collaboration, or prompt tuning. The Workflows SDK is open source with MIT license. Developers have full access to the code and it can be executed locally. To start building today explore the GitHub repo.

(ii) Build Workflows in UI, pull to code

The Vellum Workflows SDK also supports a UI-first approach. You can start by creating a workflow in the Vellum UI, then pull it into your local environment using the CLI. From there, everything lives in code—your logic, inputs, and test scenarios—so you can iterate quickly. Just grab the Sandbox ID, run vellum workflows pull , and you’re ready to test and tweak locally. It’s a simple way to go from visual prototyping to full developer control. 👉 Sign up to try it now

## Next Steps

Now that you have the SDK and/or UI installed, you can:

Get started with the Quickstart guide Learn about Core Concepts Explore Examples

We can’t wait to see what you build.
