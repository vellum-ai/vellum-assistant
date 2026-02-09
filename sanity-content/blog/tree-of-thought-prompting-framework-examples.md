---
title: "Tree of Thought Prompting: What It Is and How to Use It"
slug: "tree-of-thought-prompting-framework-examples"
excerpt: "Learn how to use Tree of Thought prompting to improve LLM results"
metaDescription: "Compare different prompting techniques and build confidence in your prompts."
metaTitle: "Tree of Thought Prompting: What It Is and How to Use It"
publishedAt: "2023-11-30T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Compare prompts and models and build your AI app today."
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/0704bb587f12f259554c17bb0044ac31bfd3f59f-3125x2150.png"
---

Different prompting techniques can improve the results from your large language models (LLMs).

One effective technique is Tree of Thought prompting , known for its ability to handle complex reasoning tasks.

In this blog post we’ll explain the framework, provide some examples and give you advice for your use-cases.

‍

Why do you need prompting techniques?

You can achieve a lot with simple prompts, but the quality of your results will always depend on the quality of your prompt and the information you provide.

To increase the quality of your prompt, there are a few advanced prompting techniques that can guide the LLM to provide better answers, with less hallucinations. This is very useful if you expect your LLM to solve new, unseen problems that usually need intermediate steps.

There are many prompting techniques like Few-Shot prompting or Chain of Thought prompting which we covered in another post .

Today we’ll look at Tree of Thoughts.

‍

Tree of Thoughts (ToT) framework

The Tree of Thoughts (ToT) is inspired by the human mind's approach to solve complex reasoning tasks through trial and error. Put simply, this technique guides the LLM to explore different ideas, and reevaluate when needed, in order to provide the optimal solution.

This approach outperforms Chain of Thought prompting because it doesn’t stick to one “chain of thought” reasoning. However, it requires a lot of coding and custom algorithms to search through the layers to find the best reasoning path.

### How does it work?

ToT creates a tree-like structure of ideas, where each idea is a step towards solving a problem. This approach enables the LLM to self-evaluate the intermediate “thoughts” and decide whether to continue with that path or choose another.

To perform this, the authors of the ToT framework augment the LLM with search algorithms like breadth-first search and depth-first search.

![](https://cdn.sanity.io/images/ghjnhoi4/production/2bf2010ef702387c88bf3da471a1081f8cde4430-1083x550.png)

### Use-cases

The authors demonstrated that in tasks like mathematical reasoning and creative writing, the Tree of Thoughts prompting significantly exceeds the performance of other prompting methods.

This is certainly interesting. But, can we utilize this framework in a plain and simple prompt?

Turns out we can.

‍

Tree of Thoughts (ToT) prompting (with examples)

The Tree of Thoughts prompting (ToT) is adapted to the Tree of Thoughts framework, where the author tried to fit the whole concept in a single prompt.

The example below showcases the structure of the prompt.

It's important to know that GPT-3.5 doesn't get the right answer for the below example with Chain of Thought prompting, but it does with ToT prompting.

### Example

ToT prompt

###### Imagine three different experts are answering this question. All experts will write down 1 step of their thinking,then share it with the group. Then all experts will go on to the next step, etc. If any expert realises they're wrong at any point then they leave. The question is...

‍

The response from GPT-3.5:

###### Expert 1: The ball is in the living room. Expert 2: The ball is in the kitchen. Expert 3: The ball is in the bedroom. Expert 1: Bob carries the cup to the bedroom, so the ball must be in the cup. Expert 2: Oh, I see my mistake. Yes, the ball is in the cup. Expert 3: Agreed, the ball is in the cup in the bedroom. Expert 1: Next, Bob turns the cup upside down in the bedroom. Expert 2: After that, Bob walks to the garden and puts the cup down. Expert 3: Therefore, the ball must have fallen out of the cup when Bob turned it upside down in the bedroom. So, the ball is in the bedroom, not in the cup anymore. Expert 1: Oh, you're right. I made a mistake. The ball is in the bedroom, not in the cup. Expert 2: Agreed, the ball is in the bedroom. Expert 3: Bob then walks to the garage, so the ball remains in the bedroom. It is not in the garden or the garage. Expert 1: Absolutely, the ball is still in the bedroom. Expert 2: Yes, the ball hasn't moved from the bedroom. Expert 3: Therefore, the ball is in the bedroom, not in the garden or the garage. All three experts agree that the ball is in the bedroom.

‍

Some limited data from the authors shows that this prompting technique does better than Chain of Thought prompting on GPT 3.5, so it’s definitely worth exploring if you want to achieve better results with a less expensive model than GPT-4.

It’s always useful to compare various techniques with different models and evaluate which one will produce the best result for your use-case.

‍

Want to compare prompting techniques?

If you want to experiment with various prompt techniques across various models for your use-case - we can help you!

Vellum has the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production.

You can take a look at our use-cases , or book a call to talk with someone from our team.

## Table of Contents

Why do you need prompting techniques? Tree of Thoughts (ToT) framework Tree of Thoughts (ToT) prompting (with examples) Compare more prompting techniques
