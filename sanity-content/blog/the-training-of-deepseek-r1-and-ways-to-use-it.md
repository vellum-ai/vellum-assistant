---
title: "Breaking down the DeepSeek-R1 training process—no PhD required"
slug: "the-training-of-deepseek-r1-and-ways-to-use-it"
excerpt: "Learn how DeepSeek achieved OpenAI o1-level reasoning with pure RL and solved issues through multi-stage training."
metaDescription: "Learn how DeepSeek achieved OpenAI o1-level reasoning with pure RL and solved challenges through multi-stage training."
metaTitle: "How DeepSeek-R1 Was Built; For dummies"
publishedAt: "2025-01-24T00:00:00.000Z"
readTime: "10 min"
isFeatured: true
expertVerified: true
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
reviewedBy: "Nicolas Zeeb"
category: "Guides"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/92f5a9c68794f756b4d49831a5be32a945c71407-968x601.heif"
cta: "Want to test DeepSeek against other model providers?"
---

TLDR;

DeepSeek just made a breakthrough: you can train a model to match OpenAI o1-level reasoning using pure reinforcement learning (RL) without using labeled data (DeepSeek-R1-Zero). But RL alone isn’t perfect — it can lead to challenges like poor readability. A mix of methods in a multi-stage training fixes these (DeepSeek-R1).

--

The launch of GPT-4 forever changed the AI industry. But today, it feels like an iPhone 4 compared to the next wave of reasoning models (e.g. OpenAI o1).

These "reasoning models" introduce a chain-of-thought (CoT) thinking phase before generating an answer at inference time, which in turn improves their reasoning performance.

While OpenAI kept their methods under wraps, DeepSeek is taking the opposite approach — sharing their progress openly and earning praise for staying true to the open-source mission. Or as Marc said it best:

Deepseek R1 is one of the most amazing and impressive breakthroughs I’ve ever seen — and as open source, a profound gift to the world. 🤖🫡 &mdash; Marc Andreessen 🇺🇸 (@pmarca) January 24, 2025

This open-source reasoning model is as good as OpenAI’s o1 in tasks like math, coding, and logical reasoning, which is a huge win for the open-source community… and the world (Marc, your words not ours!)

As someone who spends a lot of time working with LLMs and guiding others on how to use them, I decided to take a closer look at the DeepSeek-R1 training process. Using their paper as my guide, I pieced it all together and broke it down into something anyone can follow—no AI PhD required. Hopefully you'll find it useful!

Now, let’s start with the fundamentals.

# A quick primer

To better understand the backbone of DeepSeek-R1, let's cover the basics:

Reinforcement Learning (RL): A model learns by receiving rewards or penalties based on its actions, improving through trial and error. In the context of LLMs, this can involve traditional RL methods like policy optimization (e.g., Proximal Policy Optimization, PPO ), value-based approaches (e.g., Q-learning ), or hybrid strategies (e.g., actor-critic methods ). Example: When training on a prompt like "2 + 2 =", the model receives a reward of +1 for outputting "4" and a penalty of -1 for any other answer. In modern LLMs, rewards are often determined by human-labeled feedback (RLHF) or as we’ll soon learn, with automated scoring methods like GRPO .

Supervised fine-tuning (SFT) : A base model is re-trained using labeled data to perform better on a specific task . Example: Fine-tune an LLM using a labeled dataset of customer support questions and answers to make it more accurate in handling common queries. Great to use if you have an abundance of labeled data.

Cold start data : A minimally labeled dataset used to help the model get a general understanding of the task. * Example: Fine-tune a chatbot with a simple dataset of FAQ pairs scraped from a website to establish a foundational understanding. Useful when you don’t have a lot of labeled data.

Multi-stage training : A model is trained in phases, each focusing on a specific improvement, such as accuracy or alignment . Example: Train a model on general text data, then refine it with reinforcement learning on user feedback to improve its conversational abilities.

Rejection sampling: A method where a model generates multiple potential outputs, but only the ones that meet specific criteria, such as quality or relevance, are selected for further use. Example: After a RL process, a model generates several responses, but only keeps those that are useful for retraining the model.

# First model: DeepSeek-R1-Zero

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/683e9339644a5ba46f7c3338584ccf305e0a6184-1178x272.png)

The team at DeepSeek wanted to prove whether it’s possible to train a powerful reasoning model using pure -reinforcement learning (RL). This form of "pure" reinforcement learning works without labeled data.

Skipping labeled data? Seems like a bold move for RL in the world of LLMs.

I've learned that pure-RL is slower upfront (trial and error takes time) — but iteliminates the costly, time-intensive labeling bottleneck. In the long run, it’ll be faster, scalable, and way more efficient for building reasoning models. Mostly, because they learn on their own.

DeepSeek did a successful run of a pure-RL training — matching OpenAI o1’s performance .

Calling this a 'huge accomplishment" feels like an understatement—it’s the first time anyone’s made this work. Then again, maybe OpenAI did it first with o1, but we’ll never know, will we?

The biggest question on my mind was: 'How did they make it work?'

Let’s cover what I found out.

> If you want to get similar resources, join our newsletter.

## Using the GRPO RL framework

Traditionally, RL for training LLMs has been most successful when combined with labeled data (e.g the PPO RL Framework ). This RL approach employs a critic model that’s like an “LLM coach”, giving feedback on each move to help the model improve. It evaluates the LLM's actions against labeled data, evaluating how likely the model is to succeed (value function) and guiding the model’s overall strategy.

The challenge?

This approach is limited by the labeled data it uses to evaluate decisions. If the labeled data is incomplete, biased, or doesn’t cover the full range of tasks, the critic can only provide feedback within those constraints — and it won’t generalize well.

Enter, GRPO!

The authors used the Group Relative Policy Optimization (GRPO) RL framework (invented by the same team, wild!) which eliminates the critic model .

With GRPO, you skip the ‘coach’—and the LLM moves are scored over multiple rounds by using predefined rules like coherence and/or fluency . These models learn by comparing these scores to the group’s average.

But wait, how did they know if these rules are the right rules?

In this method, the rules aren't perfect—they’re just a best guess at what "good" looks like. These rules are designed to catch patterns that usually make sense, like:

Does the answer make sense? (Coherence) Is it in the right format? (Completeness) Does it match the general style we expect? (Fluency)

For example, for the DeepSeek-R1-Zero model, for mathematical tasks, the model could be rewarded for producing outputs that adhered to mathematical principles or logical consistency, even without knowing the exact answer.

It makes sense.. and &nbsp;it works!

The DeepSeek-R1-Zero model had great performance on reasoning benchmarks. Plus it had a 86.7% of pass@1 score on AIME 2024 (a prestigious mathematics competition for high school students), matching the performance of OpenAI-o1-0912.

While this seems like the biggest breakthrough from this paper, the R1-Zero model didn’t come with a few challenges: poor readability, and language mixing.

# Second model: DeepSeek-R1

Poor readability and language mixing is something you’d expect from using pure-RL, without the structure or formatting provided by labeled data.

Now, with this paper, we can see that multi-stage training can mitigate these challenges. In the case of training the DeepSeek-R1 model, a lot of training methods were used:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/cd0ed51a820da42720b0ea18227acd1f237d427c-1548x784.png)

Here’s a quick explanation of each training stage and what it was done:

Step 1: They fine-tuned a base model (DeepSeek-V3-Base) with thousands of cold-start data points to lay a solid foundation. FYI, thousands of cold-start data points is a tiny fraction compared to the millions or even billions of labeled data points typically required for supervised learning at scale.

Step 2: Applied pure RL (similar to R1-Zero) to enhance reasoning skills.

Step 3: Near RL convergence, they used rejection sampling where the model created it’s own labeled data (synthetic data) by selecting the best examples from the last successful RL run. Those rumors you've heard about OpenAI using smaller model to generate synthetic data for the O1 model? This is basically it.

Step 4: The new synthetic data was merged with supervised data from DeepSeek-V3-Base in domains like writing, factual QA, and self-cognition. This step ensured the model could learn from both high-quality outputs and diverse domain-specific knowledge .

Step 5: After fine-tuning with the new data, the model goes through a final RL process across diverse prompts and scenarios.

This feels like hacking — &nbsp; so why does DeepSeek-R1 use a multi-stage process?

Because each step builds on the last.

For example (i) the cold start data lays a structured foundation fixing issues like poor readability, (ii) pure-RL develops reasoning almost on auto-pilot (iii) rejection sampling + SFT works with top-tier training data that improves accuracy, and (iv) another final RL stage ensures additional level of generalization.

With all these additional steps in the training process, the DeepSeek-R1 model achieves high scores across all benchmarks visible below:

‍

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7c1c6be860c034267574cc5a151d9c8ed2bede71-4702x2787.png)

## CoT at inference time relies on RL

To effectively use chain-of-thought at inference time, these reasoning models must be trained with methods like reinforcement learning that encourage step-by-step reasoning during training. It’s a two-way street: for the model to achieve top-tier reasoning, it needs to use CoT at inference time. And to enable CoT at inference, the model must be trained with RL methods.

If we have this in mind, I’m curious why OpenAI didn’t reveal their training methods—especially since the multi-stage process behind the o1 model seems easy to reverse engineer.

It's clear they used RL, generated synthetic data from the RL checkpoint, and applied some supervised training to improve readability. So, what did they really achieve by slowing down the competition (R1) by just 2-3 months?

I guess time will tell.

# How to use DeepSeek-R1

To use DeepSeek-R1 you can test it out on their free platform , or get an API key and use it in your code or via AI development platforms like Vellum . Fireworks AI also offers an inference endpoint for this model.

The DeepSeek hosted model, costs just $0.55 per million input tokens and $2.19 per million output tokens — making it about 27 times cheaper for inputs and nearly 27.4 times cheaper for outputs than OpenAI’s o1 model.

This API version supports a maximum context length of 64K, but doesn’t support function calling and JSON outputs. However, contrary to OpenAI’s o1 outputs, you can retrieve both the “reasoning” and the actual answer. It's also very slow, but no one cares about that with these reasoning models, because they unlock new possibilities where immediate answers aren't the priority.

Also, this version doesn’t support many other parameters like: temperature 、 top_p 、 presence_penalty 、 frequency_penalty 、 logprobs 、 top_logprobs, making them a bit harder to be used in production.

## API example with DeepSeek-R1

The following Python code demonstrates how to use the R1 model and access both the CoT process and the final answer:

I'd suggest you play with it a bit, it's quite interesting to watch it 'think'

# Small models can be powerful too

The authors also show the reasoning patterns of larger models can be distilled into smaller models, resulting in better performance.

Using Qwen2.5-32B (Qwen, 2024b) as the base model, direct distillation from DeepSeek-R1 outperforms applying just RL on it. This demonstrates that the reasoning patterns discovered by larger base models are crucial for improving reasoning capabilities for smaller models. Model distillation is something that is becoming quite an interesting approach, shadowing fine-tuning at a large scale.

The results are quite powerful too -- A distilled 14B model outperforms state-of-the-art open-source QwQ-32B-Preview by a large margin, and the distilled 32B and 70B models set a new record on the reasoning benchmarks among dense models:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/80c6b1b1832a255c94df89fb39964b4b24aa7576-854x816.png)

## Conclusion

Here’s my take: DeepSeek just showed that you can significantly improve LLM reasoning with pure RL, no labeled data needed. Even better, they combined post-training techniques to fix issues and take performance to the next level.

Expect a flood of models like R1 and O1 in the coming weeks—not months.

We thought model scaling hit a wall, but this approach is unlocking new possibilities, meaning faster progress. To put it in perspective, OpenAI took 6 months from GPT-3.5 to GPT-4. DeepSeek matched O1’s performance in just 2 months—without knowing how OpenAI did it!

Get ready for a new wave of models that will make O1 look slow.

## Extra resources

Beginner’s Guide to Building AI Agents → Best Enterprise AI Agent Builder Platforms → Best Low code AI Workflow Automation Tools → Guide: No Code AI Workflow Automation Tools → Best AI Workflow Platforms →

{{general-cta}}
