---
title: "Introducing Custom Docker Images & Custom Nodes"
slug: "introducing-custom-docker-images-custom-nodes"
excerpt: "Complete control over the business logic and runtime of your AI workflows in Vellum."
metaDescription: "Complete control over the business logic and runtime of your AI workflows in Vellum."
metaTitle: "Introducing Custom Docker Images & Custom Nodes"
publishedAt: "2025-07-15T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/9d554a01e2f8bd3f82d17ec5585ae9f7aa412742-2099x1311.png"
---

In most organizations, there is one central AI team that usually ends up being the bottleneck. They know the systems best, so every request goes through them. But that doesn’t scale. The real challenge today is letting other teams build with AI without needing constant help.

In the past, we’ve launched features to help these teams scale: things like Python or TypeScript defined Custom Metrics , and Code Execution Nodes that run single-file logic with public packages. We’ve also enabled logic sharing through SubWorkflows , letting teams expose reusable endpoints to their AI workflows.

But that’s wasn't enough.

Custom Nodes and Custom Docker Images are the next step in the evolution of how Vellum helps these AI teams scale in a much more powerful way. Custom Nodes let you write reusable logic using the SDK and expose it in the UI, while Custom Docker Images give you full control over their runtime, so you can install system-level dependencies, rely on private packages, and reference pre-defined application code.

🔗 Sign up here to start using both today. Keep reading to learn how each one works and the design choices behind them.

## Design Principles

The support for Custom Nodes and Custom Docker Images gives engineering teams full control over how they write, share and execute their AI logic. We’ve designed these components with two things in mind:

(i) Maximum flexibility using first-class primitives: Vellum's native nodes and runtimes use the same architecture. All of Vellum's nodes inherit from BaseNode (the same base class you'd inherit from when defining a custom node) and all Vellum workflow runs occur within a docker container whose images serves as the base image for your custom runtimes. This means that whether you use a default Vellum Node (e.g. Prompt Node) or create your own logic, the system will handle both equally. This design choice ensures maximum reliability and flexibility from the ground up.

(ii) Zero trade-offs: We’ve seen first-hand that AI projects only reach production when engineers and subject matter experts work together, and when engineering teams fully own their code so they can test, debug, and improve it like any other critical system. That’s why we made no trade-offs between flexibility and performance, or control and usability. Our platform is built to support every part of the AI engineering workflow: tight SDK integration, a visual UI for collaboration, and full environment-level control over your runtime that’s fast, secure and performant.

## Define custom logic with Custom Nodes

Custom Nodes allow you to extend the functionality of your Workflows with specialized logic that isn’t available in the standard Vellum Node Library.

Engineers can extend BaseNode and override its run method to include any logic they'd like. When you push it to Vellum, it becomes a Custom Node tied to that workflow , and anyone from your team can use it directly in the Vellum UI.

Each Custom Node you create is versioned and reusable, with clearly defined inputs and outputs, so other teams can use it confidently without needing to understand its internal logic. It’s a simple way to turn your existing functions or service logic into standard components that non-technical teams can drag into workflows in the UI, or for use as tools by an Agent.

### Example Custom Node

In the image below you'll see a preview of the MCPClientNode which is a Custom Node defined using the SDK, which was then pushed up to Vellum. The UI represents it as a Node with clearly defined inputs and outputs, ready to be used by any non-engineer:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/849572f0952f8f7a0f10a94e70ce2be7bdfe7634-3102x1936.png)

Get Started with Custom Nodes Check this guide to understand how to extend BaseNode to create Custom Nodes in Vellum Workflows.

## Control your runtime with Custom Docker Images

Custom Nodes are great when you want to write your own logic for a workflow. If you only ever need to write logic that depends on Python's standard library, or the Vellum SDK, then you're all set. But, it's likely that you want to import existing application code, or maybe even install system-level dependencies. That's where Custom Docker Images come in.

The support here goes way beyond just pip install . There are really two categories where this becomes a big deal:

Pip packages that need more than just pip: like nltk or PDF parsing, image processing or anything that requires running a separate script to actually download the data before it works. Your own existing codebase: maybe you already have business logic that lives in a monorepo or backend. Instead of spinning up an API just for your Workflow to access it, or copy-pasting it into a one-off script, you can build a custom node that imports it into its run method directly, drop it into a Docker image, and run it in your workflow.

With Customer Docker Images you have full control over your environment and you’re no longer boxed into flattening your code to fit one file. This functionality will open so many use-cases for teams building for production, and we can’t wait to see what you’ll build.

### Example Docker Image

For example, the docker file below creates a container that runs a Python server for Vellum workflows, with boto3 , mcp , and our own utility code pre-installed and ready to be used inside a custom node:

In addition to custom code and utilities, you can also include Custom Nodes that will be available in the Workflow UI. To include custom nodes in your Docker Image, you must organize them in a specific directory structure:

Then in the UI, you just point to the pushed Docker image that contains all your dependencies. On the next run, Vellum will execute the logic inside that image.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8897448037f63cd0c70af6e48bb997f2deac0a12-1974x474.png)

Get Started with Custom Docker Images Check this guide to understand how to configure and run a Custom Docker image.

## What’s next

Today, we auto-generate inputs and outputs based on your code.

But long-term, we want to give developers full control over how generic nodes are rendered in the UI. For example, if you're building your own proprietary version of our prompt node, you’ll be able to use our model chip, prompt editor, or document picker components to shape the UI of your custom node.

Think of it like Slack’s Block Kit Builder . Just as you can design buttons, forms, or lists in a Slack integration, you’ll be able to define not only how your node, behaves, but also how it looks and is interacted with in the Vellum UI. The goal is to let engineers build both the logic and the UI, so non-technical teammates and other engineering teams can interact with complex nodes through a clean, intuitive interface.
