---
title: "Vellum Product Update | January 2025"
slug: "vellum-product-update-january-2025"
excerpt: "Vellum 2025: Workflows SDK Beta, self-serve org setup, and new model support! "
metaDescription: "Vellum 2025: Workflows SDK Beta, self-serve org setup, and new model support! "
metaTitle: "Vellum Product Update | January 2025"
publishedAt: "2025-02-11T00:00:00.000Z"
readTime: "4 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
imageAltText: "Vellum-product-update-january"
authors: ["Sharon Toh"]
category: "Product Updates"
tags: ["Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1dcb3c94f2741337d43cf4a6a4537961eb83a383-716x493.png"
---

## New Year, New Features: January’s Updates 🎉

2025 is here, and we’re kicking off the year with some exciting updates for you.

From self-serve organization setup to support for DeepSeek models, this month’s updates are all about providing you even more support.

# 🥳 Beta Launch: Workflows SDK

We're launching the beta release of Workflow SDK : define, edit, and run in code or UI, and push/pull changes between the two - eliminating the technical gap within cross-functional teams. Existing Workflows can now be made SDK-compatible by checking “SDK Compatible” checkbox while creating a new Workflow:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/18409234236b60e09a6df6e6e01b809bcfb965c0-658x255.png)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/308b2dcbb06feded4671eea0e94b6247a40280c8-904x239.png)

‍

Once made “SDK enabled” – your Workflow will run on new infrastructure and will be compatible with new and exciting features that will be rolling out soon. For more info on Workflows SDK, check out our docs here .

# 🚀 Key New Features

## Organization Automated User Access &amp; Self-service

We're making it easier for users to securely join Vellum Organizations and Workspaces with the rest of their team. With a redesigned Organization Settings Page, admins can now set domain-based join policies, allowing new team members with pre-approved email domains to automatically join upon signup — no manual invites needed. Additionally, organization setup is now fully self-service, enabling new users to create their own organization or automatically join an existing one based on their email domain, if permitted.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/c23fda7b0eb2281ae4d4b065f1a6303a4a6af8aa-1126x1220.png)

## View Cost &amp; Model in Workflows Stream API

You can now see token cost and model name in Prompt Node results when executing a Workflow Deployment via the Execute Workflow Stream API. Simply set expand_meta.cost or expand_meta.model_name to True to access this metadata.

Check out the API documentation here .

## Return Cost &amp; Model Info in Workflows API Responses

You can now opt in to receive the cost incurred and the name of the model used by Prompt Nodes when executing a Workflow Deployment via the Execute Workflow Stream API. Simply set expand_meta.cost or expand_meta.model_name to True to access this metadata.

Check out the API docs for details here .

## New Workflow Outputs Panel

We've added a Workflow Outputs panel in the Workflow. Click the new " Outputs " button to view all outputs your Workflow generates and easily navigate to the Nodes that produce them. Soon, you'll also be able to edit outputs directly from this panel.

## Function Call Inputs in Chat

Vellum now fully supports Function Call inputs in Chat Messages, allowing you to simulate Function Call outputs from a model within Chat History.

‍

# 🧠 New Model Support

DeepSeek AI Models, including DeepSeek V3 Chat DeepSeek R1 via Together AI &amp; Fireworks AI DeepSeek R1 Distill Llama 70B via Groq DeepSeek Reasoning Model Gemini 1.5 Flash (Latest Stable) Gemini 2.0 Flash Thinking Mode Google’s Gemini Exp 1206 Newest Perplexity Models: Sonar &amp; Sonar Pro o1-mini (2024-09-12) on Self-Managed OpenAI on Azure OpenAI’s o3-mini &amp; o3-mini-2025-01-31 Snapshot

# 📄 Document &amp; Search Enhancements

Support for PowerPoint (.pptx) files in Document Indexes for indexing &amp; searching Text Search on Document List Endpoint using search query parameter

## 🎬 That’s a Wrap!

That’s it for this month! These updates are all about giving you more control, improving workflow efficiency, and making AI development easier. Stay tuned — exciting things are coming next month!

Changelog: https://docs.vellum.ai/changelog/2025/2025-01
