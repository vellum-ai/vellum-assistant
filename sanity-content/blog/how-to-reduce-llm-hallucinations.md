---
title: "3 Strategies to Reduce LLM Hallucinations"
slug: "how-to-reduce-llm-hallucinations"
excerpt: "Methods and techniques to reduce hallucinations and maintain more reliable LLMs in production."
metaDescription: "Methods and techniques proven to reduce LLM hallucinations and maintain more reliable LLM features in production."
metaTitle: "3 Recommended Strategies to Reduce LLM Hallucinations"
publishedAt: "2024-01-03T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Reduce hallucinations and bring your AI app to production today."
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering", "Semantic Search", "Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/ecc59e5a159b0637663a7dfb27c8cc9326cef920-3125x2150.png"
---

While language models are very efficient at solving down-stream tasks without supervision, they still have some practical challenges.

LLM Hallucination is one them; and a very important one.

When a language model hallucinates, it generates information that seems accurate but is actually false.

In this blog post we’ll cover three practical methods to reduce these hallucinations and maintain more reliable LLMs in production.

‍

Ways To Reduce LLM Hallucinations

There are three practical ways to reduce LLM hallucinations:

Advanced prompting : when you want to rely on the model’s pre-trained knowledge; Data augmentation : when the additional context is not fitting the model context window; Fine-tuning : when you have a standardized task and sufficient training data.

Each of these approaches have different techniques, and we’ll cover them in the next sections.

‍

Advanced Prompting

You can resort to advanced prompting methods if your use case mostly relies on the model’s pre-trained knowledge, and you don’t need to use domain-specific knowledge.

These advanced prompting techniques guide the model to better understand the task at hand and the output that you’d like to get.

### Instruct The Model To Avoid Adding False Information

A popular practice nowadays is to clearly instruct the model not to spread false or unverifiable information. This instruction is usually added in the "system prompt".

The following system prompt used for Llama 2-Chat can be replicated and tested for your own use-case.

💬 If you don’t know the answer to a question, please don’t share false information.

### Few Shot Prompting

Few-shot prompting reduces LLM hallucinations by providing a small number of specific examples to guide the model's responses.

This approach helps the model concentrate on the specific topic, making it easier for it to grasp the context and follow the format of the examples provided. However, its effectiveness depends on the quality of these examples; inaccurate or biased examples can lead to lower accuracy &amp; sometimes more hallucinations.

### Chain Of Thought Prompting

Chain-of-thought prompting guides the LLMs to generate reasoning steps before providing the final answers. You can simply instruct the LLM to “Think step-by-step” or you can give actual reasoning examples that you’d like your LLM to follow. To understand Chain of Thought better, read our guide .

However, chain-of-thought may introduce some new challenges. The potential of hallucinated reasoning is one of them.

In cases when you want to include additional context but the content is exceeding the model’s context window, you should use data augmentation techniques.

‍

Data Augmentation

Data augmentation is a process where you equip your model’s pre-trained knowledge with proprietary data or external tools/knowledge.

Below we show two options on how to augment your model’s responses and minimize hallucinations. Keep in mind that these methods are more complex to implement.

### Retrieval-Augmented Generation

RAG is a specific technique where the model’s pre-trained knowledge is combined with a retrieval system of your proprietary data.

This system actively searches a vector database with stored information to find relevant data that can be used in the model's response. RAG can pull in and utilize proprietary data in real-time to improve the accuracy and relevance of its responses.

Fell free to reach out if you’d like to incorporate this for your use-case.

### Use Of External Tools

Integrating tools with LLMs can also decrease hallucinations. Luckily, language models like GPT-4 are smart enough to string function calls together and use multiple tools in a chain, collecting data, and planning and executing the given task.

These tools can include database calls, API invocations, scripts that perform data processing, or even separate models for specific tasks (like sentiment analysis, translation, etc.) which will in turn improve the accuracy of the outputs.

Handling this process is not simple and requires a lot of testing &amp; experimentation. Vellum’s AI tooling can help ease this process — If you’d like tailored advice on your use case — let us know.

‍

Fine Tuning

Fine-tuning is considered to be one of the most effective ways to reduce hallucinations when you have a standardized task and sufficient training data.

To start with fine-tuning, you need to collect a large number of high quality prompt/completions pairs, then experiment with different foundation models and various hyper-parameters like learning rate and number of epochs until you find the best quality for your use-case.

To learn more about when to use fine-tuning and how to do it, read this detailed guide.

‍

How To Evaluate These Strategies

Once you implement some of these methods, you need to evaluate if they actually improve your outputs. To do this, you can work with human annotators, or you can use another LLM to evaluate the data for you. Most of the latest LLM models can evaluate your LLM outputs as good as human annotators, and 100x faster.

However, even if you speed up the process with LLM evaluator, building the whole workflow is still a complex process of its own. Below we share one proven strategy that works really well for our customers, and one that you can try on your own or with Vellum .

‍

Testing Strategy To Minimize Hallucinations

The goal of this strategy is to generate enough test cases that will capture all of your edge cases, then select appropriate evaluation metrics and use the best model for the job.

Here’s a breakdown of this process:

### Develop a Unit Test Bank

Create a set of test scenarios to evaluate the LLM's ability to handle various topics and avoid hallucinations.

The common understanding is that you’ll need historical data to create these test cases. While that’s true and it’s very useful, you can also use an LLM to create synthetic data for this purpose.

### Select Appropriate Evaluation Metrics

Now, depending on your LLM task, you can use different evaluation metrics.

Here are two sets of metrics and their applications:

1. Semantic similarity + relevance metrics

Imagine you're using an LLM to generate responses to customer queries. After feeding a query to the LLM, it provides a response. To evaluate this response, you would use semantic similarity and relevance metrics to compare the LLM's response with a pre-existing, correct response to the same query.

2. Relevance, helpfulness, and authority metrics

These metrics are typically used in contexts where it's crucial to evaluate the quality and reliability of information provided, especially when dealing with factual data, advice, or expert opinions. For instance, consider a scenario where an LLM is used to provide financial advice or health information. In such cases, it's not just important for the LLM's responses to be semantically similar to known correct responses, but they also need to be relevant, helpful and credible.

If you want to read more on how to evaluate your models in production, check this guide.

‍

Conclusion

Now that you're aware of the various methods for minimizing LLM hallucinations, it's important to remember that the right technique for your task depends on a few key factors.

You should consider your project objectives, the data available to you, understand why LLM hallucinations happen, and whether your team is capable of developing and evaluating these LLM techniques. You can also bundle more methods in your setup, like fine-tuning and using extra tools, for better results.

To really make sure these methods are minimizing hallucinations, you should build a workflow to evaluate them. This is key to making sure your chosen method is truly improving your LLM's performance and reliability.

## Table of Contents

Ways To Reduce LLM Hallucinations Advanced Prompting Data Augmentation Fine Tuning How To Evaluate Hallucination Reduction Methods Testing Strategy To Minimize Hallucination Conclusion
