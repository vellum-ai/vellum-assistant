---
title: "Introducing Vellum Workflows"
slug: "introducing-vellum-workflows"
excerpt: "Vellum Workflows help you quickly prototype, deploy, and manage complex chains of LLM calls"
metaDescription: "Vellum Workflows help you quickly prototype, deploy, and manage complex chains of LLM calls in your custom AI app. Read more on how they work and how to get access."
metaTitle: "Introducing Vellum Workflows"
publishedAt: "2023-08-15T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/bc1bb84a2f2f6a8cdc10939c99119bf7515f1e1f-3456x1986.png"
---

We’re excited to launch an entirely new product area within Vellum – one we’ve been teasing for quite some time… Workflows!

Workflows is a new product in Vellum's LLM dev platform that helps you quickly prototype, deploy, and manage complex chains of LLM calls and the business logic that tie them together. We solve the "whack-a-mole" problem encountered by companies that use popular open source frameworks to build AI applications, but are scared to make changes for fear of introducing regressions in production.

## The Problem

#### Many AI use-cases require chains of prompts, but experimentation and productionization of complex chains is hard.

We have helped dozens of customers take their AI prototypes to production by delivering tools for efficient prompt engineering, tightly integrated semantic search, prompt versioning, and performance monitoring. However, as the AI industry matures, we’ve found that more and more real-world use-cases require multi-step flows across actions like semantic search, multiple prompts/LLM calls, and bespoke business logic.

For example, if building a customer-support chatbot, you may want to:

Use a fast, low-cost, model to categorize an incoming user question Depending on the categorization, query against a different index in a vector store to return relevant context about how to answer the question Feed that context into a prompt that’s been tuned to answer accurately about that topic Feed the output of that prompt into another that rephrases using your brand voice Finally, return the answer to your end user

Unfortunately, existing tools and frameworks don’t make it easy to:

Rapidly experiment with these chains both step-by-step and end-to-end – especially if you’re non-technical Make changes with confidence once in production and avoid regressions Gain visibility into the performance of the system both as a whole, and at each step in the chain

## The Solution

#### A fully managed platform for experimenting with, deploying, and managing AI workflows that power your app

Vellum Workflows provides a low-code UI for experimenting with and deploying LLM workflows to power features in your app.

You can construct a workflow using different “Nodes,” define “Input Variables” to the workflow, their values across different “Scenarios” and run with a single click to see the output at each step along the way.

![](https://cdn.sanity.io/images/ghjnhoi4/production/b67a4620b624d67b9218593486a7d5b146f298e5-1440x810.gif)

‍

You get immediate feedback on whether your chain/prompts perform the way you expect without having to edit code, inspect console logs, or hop between browser tabs. You can validate that your workflow does what it should across a variety of scenarios / test cases.

Once you’re happy, you can deploy the Workflow directly in Vellum and invoke it through an API via Vellum’s python/node SDKs. Events for nodes that you subscribe to are streamed back using Server-Sent Events .

![](https://cdn.sanity.io/images/ghjnhoi4/production/acd8fbb9346d6bbf7468a01a98b3743761a927bb-896x546.gif)

‍

By deploying your Workflow through Vellum, you can:

Mix and match models from different providers without having to integrate with each. Use the best prompt/mode for the job! Have a production-ready backend in minutes without having to write, maintain, and host complex code and orchestration logic Version your Workflow, see changes over time, and revert with one click Get full observability into the production system, viewing inputs, outputs, timestamps, and more for the workflow as a whole, as well as each Node along the way. Use role-based access control to determine which team members are allowed to experiment vs update production deployments

![](https://cdn.sanity.io/images/ghjnhoi4/production/d61526e224b29116073c0ba8ef81686556ad6d5f-1681x898.png)

## Looking Ahead

This is just the beginning! Our beta customers are already asking for things like:

A/B testing workflows for live experimentation Test suites for evaluating that workflows are doing what they should and don’t break after an “improvement” is made Composability via nested workflows More node types for executing code, making calls to 3rd party APIs, etc.

## Why Vellum?

Our focus to date has been to provide robust building blocks for creating production-ready AI applications. We’ve seen our customers assemble Vellum-powered Prompts and Semantic Search to create incredible products, version control and debug them using Vellum Deployments, and validate them when making changes using Vellum Test Suites.

Now that we have the building blocks, we’re well-positioned to help you assemble them. Workflows has been in closed-beta for a few weeks now and we already have customers using them to power their entire AI backend in production.

> Vellum Workflows give us the opportunity to really tailor different parts of our product to the end users’ needs without having to invest in tons of custom development, which has dramatically decreased our time to market. As a technical, but non-engineering stakeholder, I’m able to truly participate in the development of the product experience and help deliver personalized AI-powered experiences to customers faster than I could have ever imagined. - Adam Daigian, Product Lead at Miri Health

We firmly believe that the best AI-powered products out there will be the result of close collaboration between technical and non-technical team members. We’ve repeatedly seen engineers set up the initial scaffolding, integrations, and guard-rails, while non-technical folks run experiments and tweak prompts/chains. No other platform facilitates this collaboration as well as Vellum.

‍

## Want to give Workflows a try?

Fill out this form , and we'll set up a custom demo for you.
