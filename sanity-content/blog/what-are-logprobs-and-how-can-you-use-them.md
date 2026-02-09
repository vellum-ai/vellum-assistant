---
title: "Understanding Logprobs: What They Are and How to Use Them"
slug: "what-are-logprobs-and-how-can-you-use-them"
excerpt: "Learn what OpenAI's logprobs are and how can you use them for your LLM applications"
metaDescription: "Learn what OpenAI's logprobs are and how can you use them for your LLM applications"
metaTitle: "Understanding Logprobs: What They Are and How to Use Them"
publishedAt: "2025-12-03T00:00:00.000Z"
readTime: "8 min"
isFeatured: true
expertVerified: true
guestPost: false
isGeo: false
ctaLabel: "Evaluate your prompts with logprobs today"
authors: ["Anita Kirkovska"]
reviewedBy: "Nicolas Zeeb"
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/6143905b80362addb075d15e26c9ad770fd0abc3-727x500.heif"
---

‍

‍

LLMs are like smart text predictors. For every word or phrase they generate, they consider several possible next words and decide how likely each one is.

For example, if the model is trying to complete the sentence: “ The best movie of all time is… ” it might consider options like “The Godfather” or “Citizen Kane.” However, a choice like “Cats” would likely get a very low probability, close to 0%—not to judge, but the visual effects in that one were pretty rough!

##### When working with model outputs, particularly in machine learning and natural language processing, we often deal with probabilities , which indicate how likely an event (like predicting a word or a label) is to happen.

However, instead of using the actual probability percentages directly (like 10%), we use the logarithm of these probabilities. This is called the “log probability” or “ logprob .”

For example, a logprob of “-1” corresponds to a probability of about 10% (in a logarithmic scale), but it’s easier to work with in calculations. The more negative the logprob, the lower the probability. For instance, a logprob of “-3” indicates a much lower probability than “-1”.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/758872d306333d914b22b498e65d98e0094dd280-1400x617.png)

‍

Why Use Logprobs in Machine Learning?

We use logprobs because they make token prediction faster — and are easier for computers to work with.

It’s cheaper for computers to do addition than it is to do multiplication. Figuiring the next token is easier when you’re adding the log probabilities of each token, instead of multiplying their actual probabilities. Optimizing the log probability (logprob) is more effective than optimizing the probability itself - the gradient (the direction and rate of change) of the logprob tends to be smoother and more stable, making it easier to optimize during training!

While primarily used by researchers to evaluate model performance, some providers like OpenAI are now offering this feature in their API, allowing users to adjust this parameter in their own LLM systems.

‍

How Does OpenAI’s Logprobs Parameter Work?

OpenAI introduced the logprobs parameter in their API in 2023:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/085e2c485e517bf529019c87655ab9acf5a4234b-1290x178.png)

When logprobs is enabled, the API returns the log probabilities for each output token, along with a few of the most likely tokens and their log probabilities at each position. Here are the key parameters:

logprobs : If set to true, the API returns log probabilities for each token in the output. Note that this option isn’t available for the gpt-4-vision-preview model. top_logprobs : A number between 0 and 5 that specifies how many of the most likely tokens to return at each position, along with their log probabilities. The logprobs parameter must be true to use this option.

The higher the log probability — the higher the likelihood of a token being the correct choice in that context. You can easily understand how "confident" the model is in its output, and you can also check other potential responses the model considered.

Learn more about it here .

But, what can you do with it?

‍

What Can You Do with OpenAI’s Logprob Parameter?

You can leverage OpenAI’s logprobs to optimize your LLM in several ways, especially for tasks like classification, autocomplete, retrieval evaluation and minimizing hallucinations. You could use it in production as well as a moderation tool.

Let’s see some examples and how most of our customers &nbsp;utilize it for developing their AI features:

### Evaluating Classification

Sometimes, we use LLMs to classify content. By default, the models pick the token with the highest probability. However, we can use the logprobs parameter to check if the model’s response meets a specific logprob threshold.

Let’s say that we want to classify a user query into three categories “Product Info”, “Pricing” and “Need to talk with an Agent”.

Let’s say that this is our prompt:

And let’s say that these are some of our user questions:

If we run these queries with our LLM it’s very obvious that the first one will fall under “Product info”, the second under “Pricing”, and the third could potentially be labeled as “Product Info”, but with lower probability.

It’s easy for us to identify these simple examples just by looking at them — but if we want to scale this approach, we can adopt the logprobs parameter in the API to check whether a given classification satisfies a specific “threshold”.

Let’s see how GPT-4 Turbo will classify these queries:

For example, if the model classifies the query "How can I track my delivery status in real-time?" with less than 100% probability, we can automatically route it to our "Talk with an Agent" branch, or expand our categories to include options like "Delivery and Tracking" for more accurate classification.

### Detecting RAG Hallucinations

In our RAG-based systems, we usually pull context dynamically in our prompts to fix hallucinations and give the model more information of our knowledge. But even with this context, the model can hallucinate if the answer is not provided in these documents.

This is because these models are built to always give an asnwer, even when they don’t have the right answer .

You can use logprobs as a filter to evaluate retrieval accuracy. By setting a threshold, you ensure that only responses with a logprob close to 100% are considered reliable. If the logprob is lower, it indicates that the answer may not be found in the documents.

### Building an Autocomplete Engine

You can use logprobs to improve autocomplete suggestions as a user is typing. By setting a high confidence threshold, you can ensure that only the most likely and accurate suggestions are shown, avoiding less certain or irrelevant options.

This makes the autocomplete experience more reliable and helpful.

### Moderation Filters

Logprobs can help us screen responses to avoid rude, offensive, or harmful content. By creating an LLM evaluator, we can classify queries and block those with 100% confidence if they meet negative criteria.

### Token Healing

LLMs use tokens to process and generate text, which can sometimes lead to issues with how prompts are handled.

For example, if the model is unsure how to finish a given URL in a prompt, logprobs reveal which tokens it thinks are likely, helping you tweak the prompt to get better results.

Here’s a simple example:

If your prompt is The link is &lt;a href="http: , and the model struggles, logprobs can show which completions it’s considering. If the logprobs suggest the model isn’t sure about finishing the URL, you might adjust the prompt to The link is &lt;a href="http , which could make it more likely to generate a complete URL correctly.

Why is this the case?

When you end a prompt with “ http: ”, the model might not complete it correctly because it sees “ http: ” as a separate token and doesn’t automatically know that “ :// ” should come next. But if you end the prompt with just “ http ”, the model generates URLs as expected because it doesn’t encounter the confusing token split.

‍

Using Logprobs to improve LLM features

Logprobs are handy during prototyping for spotting issues like hallucinations and capturing problematic token generation. They can also help build a solid classifier. In production, logprobs serve as a moderation tool, allowing you to easily isolate and address problematic prompts.

Using the logprob parameter can streamline your work and provide better structure than just tweaking prompts. Many of our customers are finding it valuable for building more reliable systems right from the start.

A good AI development platform can help with this experimentation.

With Vellum’s Prompt Playground , you can easily adjust your prompts and compare how different scenarios play out, whether you use the logprobs feature or not.

If you’re interested in comparing multiple prompts, with or without the logprob parameter — get in contact here.

{{general-cta}}

## Extra resources

Beginner’s Guide to Building AI Agents → Best Enterprise AI Agent Builder Platforms → Best Low code AI Workflow Automation Tools → Guide: No Code AI Workflow Automation Tools → Best AI Workflow Platforms →

## Table of Contents

Why Logprobs? How do they work? What can you do with logprobs? Using logprobs today
