---
title: "Thinking tokens"
slug: "thinking-tokens"
metaDescription: "Thinking tokens in Anthropic’s Claude models control how much internal reasoning the AI does before answering. Learn how they work, when to use them, and how they affect speed, accuracy, and cost."
supportedBy: ["Anthropic", "DeepSeek"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

## What are Thinking Tokens?

Thinking tokens are tokens Anthropic models use internally to “think” before answering. Instead of writing words you see, these tokens are spent on reasoning steps that help the model reach a more accurate answer.

More thinking tokens → deeper reasoning, better accuracy. Fewer thinking tokens → faster, cheaper responses. You don’t see the reasoning directly, only the final output.

This is Anthropic’s version of what OpenAI calls Reasoning Effort .

## How do Thinking Tokens work?

When you send a prompt to Claude, the model goes through two phases:

Reasoning phase → the model uses thinking tokens to plan, calculate, and work out its response. Response phase → the model writes the answer you see.

By adjusting the number of allowed thinking tokens, you can control how much “internal reasoning” Claude does.

That means:

Fewer tokens = faster, lighter, but may miss details. More tokens = slower, more costly, but higher accuracy.

## How to use Thinking Tokens with Claude models

You can manage thinking tokens through Anthropic’s API by adjusting the max_tokens values dedicated to reasoning.

Example (pseudo-code):

Key things to know Separate from output tokens : Thinking tokens are used before the model generates visible text. Not always needed : For simple Q&amp;A, you won’t see a big benefit from higher thinking tokens. Best for complex tasks : Math, logic, scientific explanations, long reasoning chains. Trade-off : More thinking tokens = more accurate but also slower and more expensive. Example use cases Low thinking tokens → Customer support, short summaries, FAQs. Medium thinking tokens → General problem-solving and research. High thinking tokens → Complex multi-step math, logic puzzles, in-depth scientific/technical questions. When to use Thinking Tokens? When your use case needs accuracy over speed . For multi-step reasoning tasks like proofs, math, or code. For evaluations where you want Claude to be careful and thorough. When experimenting with cost/performance trade-offs in production. How to use the thinking tokens with DeepSeek? To use DeepSeek-R1 in reasoning mode via API, set the model to deepseek-reasoner . Here's a simple example using the OpenAI-style SDK:

‍

This tells DeepSeek to run full reasoning internally and return an answer.

### Key things to know for using the thinking tokens with DeepSeek

Single switch : No reasoning budget to tune—just pick the dedicated deepseek-reasoner model. Best for complex tasks : Optimized for multi-step logic, math, coding, and reasoning-heavy queries. Fully open-source : DeepSeek-R1 is MIT licensed and released openly, great for research and customization. ‍ Pricing : Input tokens: $0.14 per million (cache hit), $0.55 per million (cache miss) Output tokens: $2.19 per million
