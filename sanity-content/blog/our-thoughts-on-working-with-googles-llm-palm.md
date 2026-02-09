---
title: "Our thoughts on working with Google's LLM: PaLM"
slug: "our-thoughts-on-working-with-googles-llm-palm"
excerpt: "Compare model quality across OpenAI's GPT-4, Anthropic's Claude and now Google's PaLM LLM in our platform"
metaDescription: "More info on PaLM and comparison of the model quality across OpenAI's GPT-4, Anthropic's Claude and now Google's PaLM LLM in our platform"
metaTitle: "Our thoughts on working with Google's LLM: PaLM"
publishedAt: "2023-05-10T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today"
authors: ["Akash Sharma"]
category: "Product Updates"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Earlier today Vellum was announced at Google I/O as an integration partner for their PaLM API, we’re thrilled to bring this new model to production use cases through our platform. If you have access to PaLM, you can use our Playground to compare PaLM side-by-side with models like OpenAI's GPT-4, Anthropic's Claude, and even open source models like Dolly from Databricks.

![](https://cdn.sanity.io/images/ghjnhoi4/production/4eafd7bb714264ba0d5fe75711e813f96dc01164-2870x1534.png)

‍

‍

With an ever increasing number of foundation model providers, it gets difficult to choose the best prompt/model for your use case. One of the challenges here is measuring model quality, a topic we’ve written about in a prior blog here . When choosing the a model for your use case, our first recommendation is to find a model that clears your quality threshold after extensive unit testing. If multiple models clear your quality threshold, then choose based on other criteria like latency, cost and privacy.

In this article we’ll share how we experimented with PaLM and where it did better than other model providers.

### I’ve heard of BARD, what is PaLM?

You can learn a lot more about Google’s AI offerings on their website, but in summary, BARD is the consumer application that Google is creating (similar to ChatGPT) while PaLM is a series of Large Language Models models similar to OpenAI’s GPT models or Anthropic’s Claude models.

PaLM also has an embedding model that can be used instead of OpenAI’s Ada or open source models like Instructor .

### How we used PaLM and what we learned?

We’ve been doing side by side comparisons between OpenAI, Anthropic and Google (PaLM) and after sufficient prompt engineering to get good quality, we found PaLM to really shine in how quickly and accurately it gave responses. This is particularly true for chain of thought / reasoning related prompts. Let’s talk through an example.

We're creating an escalation classifier for incoming support messages for a computer repair shop. Usually front-line support representatives escalate messages to their manager if the customer is unhappy or angry. We're having the escalation classifier perform the same task. This is how the prompt is constructed:

Give the LLM the 8 criteria which would result in escalation (e.g., customer is asking to speak to the manager, customer is upset, customer is repeating themselves etc.) Ask the LLM to take the incoming message and check if it meets any of the criteria In the final response, return which criteria were met and a true/false for whether the message should be escalated

In Vellum's Playground, you can clearly see PaLM's responses were more accurate and noticeably faster than other model providers. Here’s a video to bring it to life

### Want to compare these models yourself?

Sign up for a 7 day free trial of our platform here and use our Playground for side by side model comparison. For any questions or feedback, please reach out at founders@vellum.ai
