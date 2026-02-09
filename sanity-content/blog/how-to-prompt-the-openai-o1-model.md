---
title: "OpenAI o1: Prompting Tips, Limitations, and Capabilities"
slug: "how-to-prompt-the-openai-o1-model"
excerpt: "Learn how to prompt OpenAI o1 models, understand their limits and the opportunities ahead."
metaDescription: "Learn how to prompt OpenAI o1 models, understand their limits and the opportunities ahead."
metaTitle: "OpenAI o1: Prompting Tips, Limitations, and Capabilities"
publishedAt: "2024-09-13T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Evaluate the OpenAI o1 models"
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1f576bbaa0ecf14033845ae5292d9d7d2a477145-727x500.png"
---

The latest models from OpenAI—the OpenAI o1 and its "mini" version—operate differently from previous GPT models. These reasoning models are trained to think through their answers step by step before responding to the user. This means that each time you prompt these models, they will take some time to internally "think" before producing the final answer.

The performance gains are huge — for math reasoning specifically, the OpenAI o1 model is 70% more accurate.

These new qualities open up many opportunities, but there are also several limitations—in fact, this is still just version 1. But one thing is sure, these models are behaving differently, and we need to rethink our prompting methods.

Let’s look at what’s changed, how to prompt these models, understand their limits and the opportunities ahead.

‍

A Primer on Chain of Thought

We wrote more on chain of thought here , but let’s cover this technique briefly.

Traditional LLMs (GPT-4o and alike) tend to predict the next word or token without fully working through the reasoning process, especially for multi-step problems like math or logic. They predict the next word (token) in the sentence based on a calculated probability within the context of that sentence.

The more complex the task, the easier it is for the model to lose track. So, Chain of Thought (CoT) works well because it helps break down complex reasoning tasks into smaller, more manageable steps.

With that, the models focus on solving one part of the problem at a time — and their accuracy increases.

For example, instead of just asking "Solve 2x + 3 = 7," we can include the intermediate steps that the model should follow to arrive at the correct answer:

System message: You’re the best mathematician in the world and you’ll help me solve linear equations. Example: For the equation 5x - 4 = 16 1. Add 4 to both sides: 5x - 4 + 4 = 16 + 4 → 5x = 20 2. Divide both sides by 5: 5x / 5 = 20 / 5 → x = 4

User message: Now solve 2x + 3 = 7

This technique was widely used by everyone, and today, OpenAI has integrated this natively in the model — making it more powerful for reasoning tasks.

So basically, these models are smarter and don’t want to be confused with lots of prompting. Let’s see what that means.

‍

How to Prompt OpenAI o1

Now, since these models performs chain-of-thought prompting internally, the best prompts for these “reasoning” models will be different. That means that some things are gonna change.

Here’s what OpenAI recommends:

### 1) Keep prompts simple

These models are trained to work best if you just write simple, straightforward prompts. They won’t need extensive guidance because they can find the most optimal path themselves.

### 2) Avoid using CoT

Because the chain of thought technique is part of the model’s reasoning already, using your own reasoning in the prompts won’t work and might hinder the performance.

### 3) Use Delimiters for Quality

This technique applies for all previous models as well as this one. To clearly indicate parts of your prompt, use delimiters like “###”, XML tags or section titles.

### 4) Limit Additional RAG

If you want to add more context in your prompt via RAG, make sure you only include the most relevant information. Providing a lot of information at inference time might make the model “overthink” and take more time to get to the answer.

But, OpenAI hides the actual reasoning process, and we don’t know how the model breaks down a given reasoning challenge — so determining what’s the most relevant information here will be tricky to do.

‍

Capabilities

The OpenAI o1 models are powerful because they "think" through problems out of the box, thanks to their previous training using reinforcement learning algorithms.

They surpass PhD-level accuracy in science benchmarks, excels in competitive programming, and significantly improves math problem-solving, scoring 83% on a challenging exam compared to GPT-4o's 13%.

We also found out that OpenAI o1 is significantly better to solve the hardest SAT math equations, and is great at classifying customer tickets. Read more in our report here .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8498052b8ba4261ad6db1f20d1d0cefd25b4a9b0-1496x1070.png)

‍

Limits

There are a few limits that we’ve observed:

1) OpenAI hides the actual chain of thought reasoning , and there is no way for you to measure how long a given answer will take , or to understand how the model go to the answer .

2)&nbsp;The model doesn’t come with more features out of the box — things like streaming, temperature setting, use of tools and others aren’t available for this model. This can hinder many frequent use-cases today.

3) Takes too long to reach an answer. Now, more than ever, we should think about our tasks and which models are most suitable to solve them. If your use-case is not sensitive to latency you can use OpenAI o1, but for most of them test GPT-4o models and balance the tradeoffs. ‍

4) Not the best model for all use-cases. Human-experts that evaluated this model said that they don’t prefer it for some natural language tasks like creative writing.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5fe06729ad7595390ebbcf88a87056df02546809-1074x578.png)

‍

The Potential

We see the o1 models as the GPT-2 models of their time. This is just the first step, and we’ll unlock new opportunities from these models as they’re further developed, and integrated with the tools/features we need.

While GPT-4o and alike are great models to handle various production cases, the o1 technology might power more agentic applications.

Think more “Cursor AI” than Klarna chatbots.

Think more “Devins” than Github Copilot.

In these cases, you won’t mind waiting a bit longer, as completing the task or finding the right solution is more important than getting an immediate responses. We might also mix reasoning models for “planning” tasks, and use much faster models for the execution.

The coming years will set the course for the future.

If you want to learn more about these changes, receive feedback on your use case, or evaluate these models for your task, reach out to our AI experts here.

## Table of Contents

Primer on CoT Prompting Tips Capabilities Limits The Potential

‍
