---
title: "Reasoning effort"
slug: "reasoning-effort"
metaDescription: "Learn how to use the reasoning effort parameter with OpenAI's models"
supportedBy: ["OpenAI"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

## What is Reasoning Effort?

Reasoning Effort controls how much “thinking” a model does before it gives you an answer. You can set it to low , medium , or high .

Low → Quick answers, but less detailed reasoning Medium → Balanced speed and depth (default) High → Deep reasoning and more complete answers, but slower and more expensive

This parameter is especially useful for complex problem-solving, coding tasks, or math/logic problems.

## How does Reasoning Effort work?

When a model answers, it generates hidden “reasoning tokens” (sometimes called chain-of-thought).

Without adjustment → The model uses a default amount of reasoning. With Reasoning Effort → You decide how much effort it should spend “thinking” before finalizing the answer.

That means:

Less effort = faster, cheaper, but shallow responses More effort = slower, costlier, but deeper and more accurate

## How to use Reasoning Effort with OpenAI models

When calling an OpenAI reasoning model (o1, o3, o3-mini, GPT-5, etc.), you can set:

Example:

How to use Reasoning Effort with Claude models Claude 3.7 Sonnet and later also support variable reasoning depth. You can set the level of “thinking” tokens in a similar way via API (Anthropic docs recommend adjusting based on task complexity).

## Key things to know

Defaults : Medium is default if you don’t set anything. Trade-offs : Higher effort improves reasoning tasks (math, coding, logic puzzles), but takes longer and costs more. Performance : Benchmarks show accuracy can improve 10–30% at high effort, depending on the model and task. Cost : Reasoning models already cost more; “high” effort multiplies this. One study found they can be 10–74× pricier than standard models.

## Example use cases

Low → Fast Q&amp;A, customer support, summarization Medium → Most general use cases High → Advanced coding, multi-step math, research, reasoning benchmarks

## Reasoning Effort Pricing (Conceptual)

Pricing varies by model, but here’s the pattern:

Effort Level Latency Accuracy Cost Impact When to Use Low Fast Lower Cheapest Simple Q&amp;A, summaries Medium Balanced Good Normal General tasks High Slowest Highest Most Expensive Complex problem-solving

‍

## When to use Reasoning Effort?

When accuracy matters more than speed When handling complex reasoning, math, or coding problems When testing models against benchmarks or evals When you want to experiment with cost/performance trade-offs
