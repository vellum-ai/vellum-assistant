---
title: "Introducing Subworkflows (tools) for modular, reusable AI logic"
slug: "introducing-subworkflows-tools-for-modular-reusable-ai-logic"
excerpt: "Learn how to build modular, reusable, and version-controlled tools (subworkflows) to keep your workflows efficient."
metaDescription: "Learn how to build modular, reusable, and version-controlled tools (subworkflows) to keep your AI workflows efficient and maintainable."
metaTitle: "Introducing Subworkflows (tools) for modular, reusable AI logic"
publishedAt: "2024-11-27T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
tags: ["Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/3c0fa55803c22c3ae74032ebe9e1a2d0a5579c65-716x493.png"
---

AI workflows tend to grow messy as complexity increases.

That’s why we’ve built Subworkflow nodes in Vellum—a powerful new component to help you create reusable, version-controlled logic that will keep your AI workflows clean and easy to manage in production.

# What are Subworkflow nodes?

Subworkflow nodes are like self-contained tools within your workflow.

Think of them as "black boxes" that perform specific tasks, from simple calculations to running advanced code or performing SERP lookups. They take inputs, process them with some predefined logic, and produce outputs—all without cluttering your main workflow.

Imagine you're building a real estate chatbot to help users find properties or connect with agents. Instead of cramming everything in one workflow, you can use Subworkflows: one that will filter listings by budget and location, and another to gather additional user information, keeping the process modular and reusable.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d5589c0f8bfd2d9d1e04d23d442940bcd365c819-3276x1748.png)

With the Vellum Workflow builder, your team can easily:

Create reusable Subworkflows that integrate into different workflows Leverage version control to track updates or pin to static, stable versions Safely reuse components without messing with the parent workflow’s logic Simplify collaboration between developers, SMEs and PMs ‍

# Benefits for your organization

There are a few benefits from using modular components in your AI workflows.

## For developers: Simplified debugging &amp; versioning

With subworkflows, you’ll simplify your development process by breaking down complex AI systems into smaller, manageable components, making debugging and iteration much easier. Reusing tools like API handlers or parsers across workflows saves time and reduces duplication—you build them once and use them anywhere.

Inspired by software package management systems like PyPI and npm, Vellum lets you cut and tag releases for your SubWorkflows. Each version is tagged so you can pin to a version or automatically use the latest version of your subworkflow (tool).

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/e944280564940231d963e54123fd7782eb0a6942-1732x909.png)

## For SMEs: More control

Subworkflows help you ensure that business logic and requirements are consistently applied across workflows. With pinned versions, you’ll have peace of mind knowing critical logic remains stable and won’t change unexpectedly.

## For PMs: Clarity and speed

Subworkflows keep workflows organized and clear, letting you focus on delivering great user outcomes. Reusable tools and versioning enable faster, more reliable feature rollouts, with full participation from the product team throughout the process. ‍

# See It in Action

We used Vellum’s Workflow builder to build an SEO agent that has 4 tools (subworkflows) for things like keyword research, content analysis, content generation, and evaluation.

Read how we built it here and/or try the quick demo here .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/67349596b77718f1dbbb0fb01458d18f9358713a-3176x1918.png)

‍

# Try Vellum Workflows today

With Vellum’s Subworkflow nodes, you can simplify complex workflows—whether you’re keeping things organized, building reusable tools, or managing updates with version control.

If your team wants to try out Vellum’s tool (subworkflow) support and our Workflow builder , now’s the perfect time to explore how this flexibility can support your projects. Contact us on this link and we’ll have one of our AI experts help you setup your project.
