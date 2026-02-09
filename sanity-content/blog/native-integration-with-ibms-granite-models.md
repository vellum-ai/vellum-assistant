---
title: "Native integration with IBM’s Granite models"
slug: "native-integration-with-ibms-granite-models"
excerpt: "Support for IBM granite models in Vellum."
metaDescription: "Support for IBM granite models in Vellum."
metaTitle: "Native integration with IBM’s Granite models"
publishedAt: "2025-03-01T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/cf3d7a4130f792b74eef9f16eb917c1d0e726973-1074x739.png"
---

So many customers requested these models, so now we have a native integration with IBM Granite 13b Chat V2, Granite 20b Multilingual and the smaller Granite 3.2-8b Instruct model.

# About the models

Granite-13b-chat-v2 is a chat-focused model tuned to work better with RAG use cases. In version 2.1.0, IBM introduced a new alignment method designed to boost how well general LLMs perform. This method improves the base model early on by adding useful knowledge, then sharpens how it follows instructions by teaching it skills and tone in a later phase.

Granite-20b-multilingual uses a new training approach too. Instead of doing massive pre-training followed by smaller alignment, it focuses on large-scale, targeted alignment from the start. The goal is to build a general-purpose model that works well not just for chat and RAG, but also for a wide range of NLP and downstream tasks.

Granite 3.2-8b Instruct model: This model is designed to handle general instruction-following tasks and can be integrated into AI assistants across various domains, including business applications.

With this integration, you can see how these models perform for your use cases — and compare them side by side with others.

# How to enable the models

The models are now available to add to your workspace. To enable one, you need to get your API key from your your IBM profile, and add it as a Secret named IBM in the “API keys” page:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b9419076edaaab2fedb1594a0a8dae19464bfa95-1334x1092.png)

Then click on the “Model’s” tab, and add the API key and your Project ID for the specific “IBM granite” model that you want to enable:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8782a576e3f2efda0ce9af67c549406f8008065f-1894x934.png)

Then, in your prompts and workflow nodes, simply select the model you just enabled:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4d0b798b1adcc304dc0651c642b3980f41aaf9ff-2936x1796.png)

## Compare with other models

Not sure which model performs best for your use case?

With Vellum Evaluations , you can easily test and compare different LLMs side-by-side — including IBM, OpenAI, Anthropic, Google, and more. We give you the tools and best practices to evaluate accuracy, consistency, and helpfulness so you can ship AI features that actually work in production.

‍
