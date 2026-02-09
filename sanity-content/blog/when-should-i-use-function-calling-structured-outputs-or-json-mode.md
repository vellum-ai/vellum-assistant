---
title: "When should I use function calling, structured outputs or JSON mode?"
slug: "when-should-i-use-function-calling-structured-outputs-or-json-mode"
excerpt: "Learn how and when to JSON mode, structured outputs and function calling for your AI application."
metaDescription: "Learn how and when to JSON mode, structured outputs and function calling for your AI application."
metaTitle: "When should I use function calling, structured outputs or JSON mode?"
publishedAt: "2024-09-06T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build a production-grade AI product today"
authors: ["Akash Sharma"]
category: "Guides"
tags: ["Evaluation", "Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1f576bbaa0ecf14033845ae5292d9d7d2a477145-727x500.png"
---

If you’ve made it to this blog, you likely already know that LLMs predict one token at a time. Each predicted token is based on the trillions of tokens the model has seen in its training process, the context provided in the prompt &amp; all the completions so far. The predicted output token is the most likely token in the distribution of all tokens.

This works great for free-form output like email generation, blog post writing etc. but we quickly start seeing limitations when we need reliable outputs.

Here’s a common example of when LLMs fail when they’re not provided any additional guardrails or instructions. Consider this prompt:

System: You are a customer support agent working for Walmart. Your job is to look at incoming messages and determine whether they should be escalated to a human agent for review. Messages where the customer is angry or asks to speak to a manager. Create a JSON with the following schema: { should_escalate: boolean; reasoning: string; // rationale for the chosen response } Please respond with JSON only, nothing before nothing after! 🙏 User: Where’s the closest Walmart to me?

The Assistant could respond with:

This response is not valid JSON because of the three backticks before and after the JSON object. In the training process the model likely saw JSON in markdown and is outputting the backticks because those are the most likely tokens in this context.

With invalid JSON &amp; incorrect schema adherence, developers aren’t able to use these outputs reliably in the rest of their applications. Model providers saw this happen over the last few quarters and have released a suite of improvements to allow developers to build more reliable AI systems.

In this blog we will discuss:

How to choose between Function Calling, JSON Mode &amp; Structured Outputs Which model providers have these options? When are reliable outputs are needed for AI applications?

‍

Choosing between Function Calling, JSON Mode and Structured Outputs

JSON Mode was the first foray by OpenAI in creating reliable outputs. Toggling JSON mode on just required the output to be in valid JSON and did not ensure any schema adherence.

Developers wanted more and OpenAI &amp; Gemini have since released Structured Outputs .

Enabling Structured Outputs allows you to specify a JSON schema through Zod, Pydantic or through Vellum’s UI to define the JSON. When structured output is enabled the model will adhere to the specified schema in its response.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a8d76939be1b0a47e9abcda96c8cdf135c0c95c6-1798x1482.png)

We don't recommend using JSON mode by itself, you should always use Structured Outputs instead.

‍

Function Calling vs Response_format

Now, when we need models to return reliable outputs Structured Outputs is the way to go. But choosing when to use Function Calling v/s responding as-is (OpenAI calls it response_format ) is an interesting topic of exploration.

First, what is Function Calling?

You can read in detail here , but to put it simply: All major model providers make it easier for developers to call external tools or functions in their application. You can specify the schema of a function you’d like the model to call and the model would generate the appropriate parameters needed to make the function call (but not actually make the call).

Use Function Calling with Structured Outputs when:

You want to make requests to an external API You’ve given the model options of multiple tools/functions and you’d like the model to decide which tool to use (multi-agent systems) Your use case requires an ongoing interaction between the Assistant and User to collect parameters needed to make a function call (for chatbot, copilot use cases)

Use response_format with Structured Outputs when:

No interaction is needed between the Assistant and User, and usually this Assistant response is the last step in your pipeline. When there’s a specific task at hand (e.g., data extraction) and the model is not using its reasoning capabilities to pick a task

‍

Which Model Providers Support these Options?

OpenAI Anthropic Gemini Mistral JSON mode ✅ ✅ ✅ ✅ Function / tool calling ✅ ✅ ✅ Structured outputs ✅ ❌ ✅ ❌

*Gemini only supports structured outputs through Function Calling and doesn’t offer a standalone structured output option for final responses, like OpenAI does with its response_format parameter.

‍

Example Use Cases Where Reliable Outputs are Helpful

### 1. Data extraction

A common AI use case we see is extraction of structured data from unstructured fields — think obtaining the fields from a contract. Business value is clear, if an AI system can do the extraction reliably then we save countless human hours in manual data entry.

Say the input variable is a Master Services Agreement between companies and the desired output values are fields start_date , end_date , jurisdiction , force_majeure . The goal is for the model to reliably extract these values from the MSA.

Solution: Using Structured outputs with response_format will consistently ensure the model responds in the desired JSON schema it has been given.

### 2. Data analysis: Text to SQL

Getting LLMs to generate reliable SQL from natural language is tricky because the model doesn’t have full context about database schema. The initial user message also often doesn’t have all the information to make this query reliably. Some additional messages from the user might be needed.

Solution: What we’ve seen work well instead is using Structured Outputs with Function Calling to make an API call and obtain the relevant pieces of context to answer the user question.

### 3. Multi-agent systems

Composability while building AI systems is important. While building an advanced system it’s important that each agent only perform a specific task to ensure higher quality and consistency of final output. There’s usually an upstream node/agent which determines which downstream agent to call.

Solution: Use Structured Outputs with Function Calling to consistently provide the right input parameters while calling downstream agents.

‍

Need Help Getting Started?

As AI systems get more advanced, we’re here to provide the tooling and best practices to help you get the most out of them. Vellum is the AI development platform for product &amp; engineering teams with deadlines.

Take AI products from early-stage idea to production-grade feature with tooling for experimentation, evaluation, deployment, &nbsp;monitoring, and collaboration.

Reach out to me at akash@vellum.ai or book a demo if you’d like to learn more.

## Table of Contents

How to choose? Function Calling vs Response_format Model Support Examples Need Help?
