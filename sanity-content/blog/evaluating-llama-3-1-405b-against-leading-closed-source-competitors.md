---
title: "Llama 3.1 405b vs Leading Closed-Source Models"
slug: "evaluating-llama-3-1-405b-against-leading-closed-source-competitors"
excerpt: "Discover How Llama 3.1 405b Stacks Up Against GPT-4o, Gemini 1.5 Pro, and Claude 3.5 Sonnet on Three Tasks"
metaDescription: "Discover How Llama 3.1 405b Stacks Up Against GPT-4o, Gemini 1.5 Pro, and Claude 3.5 Sonnet on Three Tasks"
metaTitle: "Evaluation: Llama 3.1 405b vs Leading Closed-Source Modelst"
publishedAt: "2024-07-26T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Compare these models for your task"
authors: ["Anita Kirkovska"]
category: "Model Comparisons"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/266fd6ceda26267c62839debbc42ca42abba36c2-2250x1548.png"
---

This week, open source got an upgrade.

For the first time since the first capable LLM model was released, we have an open sourced model (Llama 3.1 405b) that can rival the best closed sourced models. It also has a much larger context window of 128K, a significant upgrade from the previous Llama models which only had 8K.

With this experiment we wanted to learn how the 405b model does in comparison to GPT-4o, Claude 3.5 Sonnet and Gemini 1.5 Pro on three tasks, math riddles, classification and verbal reasoning.

Our findings show that:

For math riddles , GPT-4o has the highest accuracy (86%), followed by every other model on this list, which had the same accuracy (79%). For classification of customer tickets , Gemini 1.5 Pro achieved the highest accuracy (74%) and highest precision (89%). For this kind of task, we really care about precision, so we were happy to see that we got a model with both high accuracy and precision, which wasn’t the case with previous evaluations of this kind. Another good option is GPT-4o (85% precision). If you care about of overall F1 score balance, then Llama 3.1 405b can be your choice as it had the highest score of 78%, and same accuracy to Gemini 1.5 Pro (74%) For reasoning tasks , GPT-4o got the highest accuracy for this task (69%), followed by Gemini 1.5 Pro (64%) and Llama 3.1 405b (56%). Claude 3.5 Sonnet did poorly on this task (44% accuracy). Running Llama 3.1 405b can be the most cost-effective and low-latency option. You can choose from at least three providers, offering significantly cheaper prices and lower latency compared to closed-source models. High speed is not an advantage for this model via any of the providers we had access so far. Both GPT-4o and Claude 3.5 Sonnet can output more tokens per second than Llama 3.1 405b. More information from Groq might chance this outcome as the community is reporting very high throughput rates !

‍

‍

Our Approach

The main focus on this analysis is to compare Llama 405b with GPT-4o, Gemini 1.5 Pro and Claude 3.5 Sonnet. We look at standard benchmarks, community-ran data, and conduct a set of our own small-scale experiments.

In the next two sections we cover:

Performance comparison (L‍‍a‍‍t‍‍e‍‍n‍‍c‍‍y‍‍,‍‍ ‍‍T‍‍h‍‍r‍‍o‍‍u‍‍g‍‍h‍‍p‍‍u‍‍t‍‍)‍‍ ‍‍ Standard benchmark comparison (example: what is the reported performance for math tasks between Llama 3.1 405b vs GPT-4o?)

Then, we run small experiments and compare the models on three tasks:

Math riddles Classification Verbal reasoning

You can skip to the section that interests you most using the "Table of Contents" panel on the left or scroll down to explore the full comparison between the models.

‍

Speed Comparison

There are still no general public access for Llama 405b on Groq, and while we’re excited to see high throughput being reported from the community , we can’t confirm how fast it is. It’s reported that it is between 100-120 tokens per second, more info on that to come!

The current highest throughput for this model is from Together.ai (69 tokens per seocond), which is still in line or lower than the closed-sourced models: GPT-4o can output 82 tokens, Gemini 1.5 Pro outputs 57 tokens, and Claude 3.5 Sonnet can output 78 tokens per second.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8519931923edd383032b23d7524c1ca30cc09ad7-1076x371.png)

‍

Cost Comparison

Since Llama 3.1 40bB is open-sourced, you have many options to run it. You can decide to run it locally, or via a hosted version from various providers. Regardless of the option you pick, using Llama will cost much less than the proprietary models we evaluate in this post.

GPT-4o costs $5 for 1M input tokens and $15 for 1M output tokens. Claude 3.5 Sonnet costs $3 for 1M input tokens and $15 for 1M output tokens. Gemini 1.5 Pro costs $3.5 for 1M input tokens and $10.5 for 1M output tokens.

You can run Llama 3.1 405b with at least 3 providers for significantly cheaper prices:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/642cd8e90cd21cf1de080e3ec5b39fb94e525e5c-944x584.png)

‍

Latency Comparison

GPT-4o has a latency of 0.49 seconds, Gemini 1.5 Pro of 1 seconds, while Claude 3.5 Sonnet is at 1.13 seconds. With Llama 3.1 70b, you can choose from at three providers who can match or even offer lower latency.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7227f3ad709d29422a9334dbd55007012a2829d8-1055x371.png)

‍

Reported Benchmarks

## Standard benchmarks

When new models are released, we learn about their capabilities from benchmark data reported in the technical reports. The image below compares the performance of Llama 70b on standard benchmarks against the top five proprietary models and one open-source model.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1bf033502e46e17f0a67ddebf1123dbc020c567a-1470x1140.png)

The data above shows that Llama 3.1 70b performs very well on math and reasoning tasks.

The 405b model is showing even better results compared to GPT-4o and Claude 3.5 Sonnet, which will be an interesting task to evaluate (analysis coming soon!).

Now let’s look at our own small experiments.

‍

Task 1: Math Riddles

In the previous section, we saw that Llama 3.1 405b has a really good score for math. Now, let's do a quick experiment to see if that's the case.

We picked a set of seven math riddles designed for students not yet in middle school and seven more at the middle school level as the cornerstone of the test. Here are a couple of example riddles and their source .

Here’s how we ran the evaluation in Vellum Evals:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9f30444242087b481e25fe2c3cfb8b10c770ce38-2405x1272.png)

From the Evaluation report below we can see that GPT-4o has the highest accuracy (86%), followed by every other model on this list, which had the same accuracy (79%).

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/04c1680e70423ee21cd93b4c80c7d5d54cbba22b-3112x812.png)

Winner: GPT-4o.

‍

Task 2: Classification

In this evaluation, we had all models to determine whether a customer support ticket was resolved or not. In our prompt we provided clear instructions of when a customer ticket is closed, and added few-shot examples to help with most difficult cases.

We ran the evaluation to test if the models' outputs matched our ground truth data for 100 labeled test cases.

Here’s how the evaluation looked like in Vellum:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a648f7777a7f6cb6af064443fb8823db9d123df9-2405x1286.png)

From this evaluation we learned that Llama 3.1 405b and Gemini 1.5 Pro shared the first spot with highest accuracy (74%), followed by Claude 3.5 Sonnet &amp; Llama 3.1 70b (70%). Interestingly, GPT-4o had the lowest accuracy (61%).

While accuracy is important, it’s not the only metric to consider, especially in contexts where false positives (incorrectly marking unresolved tickets as resolved) can lead to customer dissatisfaction. To show which model is actually the best one for this task, we calculated the precision, recall and f1 score:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5db2d0882a765e865badf1fdb1b74c7626e9eca7-2676x1416.png)

Key takeaways:

Best F1 Score : Llama 3.1 405b has the best F1 score at 77.97%, indicating a good balance between precision and recall, which can be a great option for specific use-cases like spam detection. &nbsp;Claude 3.5 Sonnet is the second best option here. Precision vs Recall Tradeoff : Gemini 1.5 Pro is the absolute winner here, with 89% precision for this task. This goes to show that this model is very good at predicting positives correctly but misses many actual positives. Second best for high precision tasks is GPT-4o with 86.96%.

In classification tasks, it is important to balance various performance metrics based on the specific needs of the task. For our use-case (classifying customer tickets) we really care about correctly identifying not-resolved tickets and we really need precision to be high.

Winner: Gemini 1.5 Pro, because it has the highest accuracy (74%) and highest precision (89%). If you care about accuracy or overall F1 score balance, then Llama 3.1 405b should be your choice.

‍

Task 3: Reasoning

From the standard benchmarks, we saw that Llama 3.1 405b got pretty similar results to GPT-4o on the MMLU dataset. So we’ll run a small test to see how they actually compare.

We picked a set of seven verbal reasoning questions and seven more arithmetic reasoning questions as the cornerstone of the test. Here are a couple of example riddles and their sources .

Now, let’s run the evaluation across all 16 reasoning questions. Here’s how that evaluation looks like in Vellum:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/aabbe7fba8075c79a3a4c2e8028a02d201328784-1565x846.png)

In the Evaluation report we got these accuracy scores:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4fcda60ce7a2b700a6e3efcc45aa35f0e073c0d1-2802x666.png)

From this evaluation, we can see that GPT-4o got the highest accuracy for this task (69%), followed by Gemini 1.5 Pro (64%) and Llama 3.1 405b (56%). Claude 3.5 Sonnet did poorly on this task (44% accuracy).

Winner: GTP-4o has the highest accuracy for reasoning.

‍

Summary

In this article, we compared the performance of Llama 3.1 405b, GPT-4o, Claude 3.5 Sonnet, and Gemini 1.5 Pro across three tasks: math riddles, classification, and verbal reasoning. Here are the key findings:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/da99199201338d83b5971bd2c3a4ad5cac4af970-2644x1418.png)

# Final Thoughts

Our evaluation reveals that while GPT-4o excels in specific tasks such as math riddles and reasoning, achieving the highest accuracy and precision, Llama 3.1 405b stands out for its cost-effectiveness and competitive performance. Gemini 1.5 Pro also demonstrates strong performance in classification tasks with the highest precision.

As open-source models continue to evolve, they are becoming increasingly viable options for various applications, providing strong competition to proprietary models like GPT-4o and Claude 3.5 Sonnet.

However, it's essential to evaluate these models for your specific use-cases to determine how well they meet your metrics and outcomes.

Source for throughput &amp; latency: artificialanalysis.ai

Source for standard benchmarks: https://ai.meta.com/blog/meta-llama-3-1/

## Table of Contents

Our Approach Speed Comparison Cost Comparison Latency Capabilities Benchmarks Task 1: Math Riddles Task 2: Classification Task 3: Reasoning Summary
