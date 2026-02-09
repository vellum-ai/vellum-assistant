---
title: "Why is collaborating on Prompt Engineering so difficult?"
slug: "why-is-collaborating-on-prompt-engineering-so-difficult"
excerpt: "Collaborating with colleagues to test prompts yields good results but it's challenging."
metaDescription: "AI prompts collaboration: Working with team members to test prompts often leads to positive outcomes, yet it can be a challenging process."
metaTitle: "Why is collaborating on Prompt Engineering so difficult?"
publishedAt: "2023-09-27T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Collaborate with the whole team, and bring your AI app to production today. "
authors: ["Akash Sharma"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/4448a1b362f6896f741ce3660ae709e08027890d-1107x762.png"
---

Prompts are the first place we see teams start with when building a Large Language Model (LLM) powered application. We’ve all experienced the power of ChatGPT, with just a few words you can get the LLM to give you a response based on what you ask. However, for an application meant for production use, you typically have to iterate on your prompts for some time before getting comfort that the prompt is ready. Prompt Engineering is the process of experimenting with, and iterating on the instructions you provide to the LLM to get it to respond the way you want it to. Coming up with the right prompt for your use case requires testing across multiple model providers, test cases and tweaking the text of your prompt to get the model to give the best results according to your quality, cost and latency criteria.

Since prompts are written in natural language, we see a large number of non technical people (e.g., product managers, designers) enter the LLM application development process. This has numerous benefits:

Faster iteration cycles: In most companies, engineering teams are usually removed from the users and the context is shared by PMs/designers to engineering teams. When the person who knows the user / product requirements creates the prompt themselves, they’re also quickly able to iterate on it until requirements are met Free up engineering capacity: Most companies are constrained on software engineering resources. When non technical teams own prompt development, engineers can then focus on the surrounding UI/UX needed to build the product Creative perspectives &amp; new ideas: Non-technical teams can bring in fresh new perspectives to solve user problems and make the

However, problems quickly emerge when coming up with good prompts &amp; iterating on them across multiple team members.

## Problem 1: Comparing results across model providers is challenging

Comparing results across different model providers (OpenAI, Anthropic etc.) can be a challenging task due to the differences in the way each model processes and responds to prompts. Each large language model has its own unique architecture, which can lead to varying results for the same prompt. Great prompt engineering requires the prompt to be modified across providers in the testing process.

The Playground environments provided by OpenAI/Anthropic also don’t allow you to measure your prompt against a predefined list of test cases. Open source models like Llama-2 and Mosaic MPT-7b don’t even have a Playground, they need to be hosted or called via an API (Replicate, Hugging Face) to get results. Open-source frameworks like Langchain and LlamaIndex don't support advanced prompt engineering too.

As a result of these challenges, the default behavior we end up seeing people often doing is testing a few examples on OpenAI’s playground using GPT-4 and putting the prompt in production. In almost all cases like this, they end up with a prompt that cannot handle edge cases effectively and is expensive and slow.

## Problem 2: There’s no standardized way to measure prompt quality

We have written a blog about how to evaluate quality of LLM features, but in summary, the evaluation approach depends on type of use case

Classification: accuracy, recall, precision, F score and confusion matrices for a deeper evaluation Data extraction: Validate that the output is syntactically valid and the expected keys are present in the generated response SQL/Code generation: Validate that the output is syntactically valid and running it will return the expected values Creative output: Semantic similarity between model generated response and target response using cross-encoders

In some cases, manual evaluation might be the desired approach. A prompt’s responses may need to be graded by subject matter experts against a pre-defined list of criteria

Setting up the correct evaluation process for prompts is a common challenge we see product development teams struggle with while building their LLM powered applications.

## Problem 3: Continuous improvements of prompts is often blocked on engineering teams

Once prompts are in production, the development process doesn’t end there. Using data from production to improve prompts is a crucial step in the iterative process of LLM app development. We’ve seen successful teams identify edge cases in production where the model doesn’t perform well, and use them as test cases for the unit test bank. Prompts are then tweaked to “clear” these test cases (based on the evaluation criteria) to improve the application quality. As new models come out (e.g., most recently Falcon-180b) we’ve seen people keep checking whether the application is still at the frontier of quality, cost &amp; latency.

In addition to the infrastructure needed to set this continuous testing process, we also see companies blocked on engineering teams to make changes to prompts. As long as prompts live in the codebase, engineers need to redeploy code to make changes to the prompts in production, slowing down the development process

## Status quo: Google Sheets, Excel &amp; Notion don’t cut it to track iterations

While Google Sheets and Notion are excellent tools for many collaborative tasks, they fall short when it comes to tracking prompt iterations.

First, they lack the ability to directly integrate with the LLMs. This means that every time you want to test a new prompt or a test case, you have to manually copy it from your Google Sheets, Notion, paste it into your LLM testing environment, and then manually copy the results back. This process is not only time-consuming but also prone to errors.

Second, these tools don’t provide a structured way to track the various parameters and results associated with each prompt iteration. For example, you might want to track the model provider, the prompt text, the response, the quality of the response, the cost, and the latency. In a spreadsheet or a Notion page, this information can quickly become disorganized and difficult to analyze.

Finally, these tools do not support version control suited for prompt engineering. This means that if you make a change to a prompt and later want to revert back to a previous version, you would have to manually track and manage these versions. This can be particularly challenging when multiple people are collaborating on the same prompt.

## Looking for a better way to collaborate?

Building the infrastructure for cross functional teams to test prompts across model providers, maintain versions, measure prompt quality &amp; iterate once in production takes a lot of engineering capacity for internal tooling, time that can be spent on building your end user features.

Vellum provides the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production — no custom code needed! Request a demo for our app here , join our Discord or reach out to us at support@vellum.ai if you have any questions!
