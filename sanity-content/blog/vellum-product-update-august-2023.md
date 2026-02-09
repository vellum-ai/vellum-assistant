---
title: "Vellum Product Update | August 2023"
slug: "vellum-product-update-august-2023"
excerpt: "August brings the introduction of Vellum Workflows, Metadata Filtering in Search, and a new design"
metaDescription: "Product updates for August: August brings the introduction of Vellum Workflows, Metadata Filtering in Search, a new design and more"
metaTitle: "Vellum Product Update | August 2023"
publishedAt: "2023-09-05T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Earlier this month, we announced the release of a whole new product area within Vellum – Workflows! Workflows help you quickly prototype, deploy, and manage complex chains of LLM calls and the business logic that tie them together. You can read more about it here .

Since its launch, we’ve been hard at work making further improvements to Workflows, but that’s not all… We’ve also managed to bring some major new features to other parts of Vellum. Let’s take a look!

‍

## Workflows

### Workflows General Availability

As mentioned, Workflows became generally available to Vellum customers this month. Vellum Workflows solve the "whack-a-mole" problem encountered by companies that use popular open source frameworks to build complex AI applications with chains of prompts, but are scared to make changes for fear of introducing regressions in production. You can read the original launch post here .

![](https://cdn.sanity.io/images/ghjnhoi4/production/833532757dd72a3d6f38d40fe79241fbb7c9f460-3456x1926.png)

### Workflows Monitoring &amp; Observability

Workflow Deployments allow you to hit a simple API and invoke a Workflow that you defined in Vellum. Workflows might contain complex interactions between vector dbs, prompts, and business logic. Being able to debug and visualize these interactions once in production becomes crucial to building production-ready AI applications.

You can now see a log of every API call made to a Workflow Deployment, as well as the inputs, outputs, and latency of each along the way.

![](https://cdn.sanity.io/images/ghjnhoi4/production/f42432516806031c31a2c9c0e83d66eef82914b2-3456x1924.png)

![](https://cdn.sanity.io/images/ghjnhoi4/production/5e03f6fa3fef822cbceca0405b92b9c932f5550a-1296x720.gif)

‍

### Templating Node

When working with chains of Prompts, you frequently need to perform basic data validation or transformation along the way. For example, you might want to validate and enrich some JSON output by an LLM or construct some payload using output from a Prompt to send to an API.

Templating Nodes are a new Node type in Vellum Workflows that help you perform this sort of light-weight data manipulation using Jinja2 templating syntax . You define the template, its inputs (which might be input variables to the Workflow as a whole, or the output of any upstream node), as well as its output type. The output of the Templating Node can then be used as an input to other downstream Nodes.

![](https://cdn.sanity.io/images/ghjnhoi4/production/6f3a4a7bad54d450ce103e1591886027c57c8a1f-3456x1314.png)

You can find a bank of common transformation tasks and example templates here .

‍

### Raw Search Results

Search Nodes previously only output a flat string containing the concatenation of chunks that matched the input query. Search Nodes also now output the raw search result, which contains each chunk’s text, as well as metadata about the chunk and the document it came from.

![](https://cdn.sanity.io/images/ghjnhoi4/production/f95ce5a79d29d7926411a9131545656cd1ce4a66-576x1366.png)

These raw results can be useful for debugging purposes, but are especially useful in conjunction with Templating Nodes. Templating Nodes can be used to create custom concatenations of chunk text. For example, this template is used to generate a string of matching chunks, with the name of the document each chunk came from. This string can then be sent to a prompt that answers questions and cites its sources (referring to the Document’s label as its source).

![](https://cdn.sanity.io/images/ghjnhoi4/production/4a3c14c4c0b44e8eb0c29043c1c5eb24bb1189a2-3456x1926.png)

## Search

### Metadata Specification &amp; Filtering

We’re excited to announce the release of a frequently-requested feature for Vellum Search – arbitrary metadata specification &amp; filtering!

Now, you can provide JSON data alongside each Document when you create them in Vellum, then filter against that data as part of Search API calls. This is useful if you want to use rule-based filtering to narrow in on a specific subset of Documents prior to performing your keyword/vector search.

![](https://cdn.sanity.io/images/ghjnhoi4/production/4fe93f766ec3b24e4e03996984d8d1f730f7a31b-3456x1924.png)

For example, if you’re storing user conversation histories, you might provide metadata that looks like: {"user_id": "&lt;user-1&gt;", "timestamp": "2023-09-01T15:51:20+0000"}.

Then, when hitting the Search API, you could narrow in on a specific user and a time range to then perform a vector search across.

## Playground

### Re-orderable Chat Messages &amp; Prompt Blocks

You can now re-order chat messages as well as Prompt blocks. Previously, you’d have to delete and re-create these items if you wanted to change their order.

![](https://cdn.sanity.io/images/ghjnhoi4/production/3cc1138ea0c13a060d1df30de7360fbd52fc1fc0-1296x721.gif)

### Resizing Improvements

You’ll generally find that resizing rows and columns in Prompt Playgrounds to be a smoother experience. We’ll continue to be making usability improvements to Prompt Playgrounds, so you can expect similar improvements soon!

Reorder-able chat messages and prompt blocks Resizing improvements

## General

### UI Revamp

As you may have noticed from all the screenshots above, we’ve given Vellum a facelift and updated our colors, fonts, and overall aesthetics.

![](https://cdn.sanity.io/images/ghjnhoi4/production/f8cf087549a486d0f9fddd4a5ea321e8524cfe86-3456x1926.png)

### Light Mode

As part of our UI Revamp, we’ve also released a new “Light Mode” of Vellum. If you prefer Light Mode or want to give it a try, you can enable it in your Profile page .

![](https://cdn.sanity.io/images/ghjnhoi4/production/1f4fc86ca6f4f916eb87e7eb19bd34014a6f2fab-3456x1926.png)

### Fine Tuned Models

We’ve now helped a number of customers create custom, fine-tuned open source models. These models are successfully being used in production and achieve higher quality, lower costs, and lower latencies than the closed-source models they were using previously. If you’re interested in joining this pilot program, you can contact us at sales@vellum.ai .

‍

## That’s a Wrap

If you’ve made it this far, thanks for following along! We’re excited for all of these improvements and hope you are too. If you’re a customer of Vellum and have feedback, please never hesitate to share it! We keep a close eye on the #feature-suggestions channel in our Discord server here: https://discord.gg/6NqSBUxF78

‍
