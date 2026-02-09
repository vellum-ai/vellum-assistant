---
title: "When to use fine-tuning?"
slug: "what-is-fine-tuning-and-when-to-use-it"
excerpt: "Fine-tuning can provide significant benefits in cost, quality & latency when compared to prompting"
metaDescription: "Fine-tuning can provide significant benefits in cost, quality & latency when compared to prompting. Learn. how and when to use it."
metaTitle: "When to use fine-tuning"
publishedAt: "2023-02-07T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Akash Sharma"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/8265b37a13172eb4fc08fd10ed88fb0ca33f495b-1107x762.png"
---

##### TL;DR: Fine-tuning can provide significant benefits in cost, quality &amp; latency when compared to prompting — we helped one of our customers increase model accuracy while decreasing cost by 94% after fine-tuning. This post provides details on how you can get started.

In our blog we will share best practices we've learned over the years on how to work with Large Language Models. The topic of today’s post is fine-tuning. This is one of the first optimization strategies we suggest because most companies we work with quickly face challenges when using LLMs with few-shot prompts in production.

### Why you should fine-tune

Prompts are an excellent way to get started with LLMs — with just a few examples, you can harness the power of Generative AI via an API call. Relying on prompts long-term, however, could result in the following problems:

High cost: If your prompts have a large context and require multiple examples for good results, the tokens (and therefore costs) quickly add up! Poor handling of edge cases (classification use cases): Due to token limits in the context window, there is a limit to how accurately your deployed model can classify inputs Limited personalization (generation use cases): Unless you’re using advanced strategies to carefully craft prompts for each request at runtime, it’s unlikely you can provide a personalized experience for each user / company / industry with a few-shot prompt because of the limited context window High latency: Long prompts, particularly those that are chained, could take 2-3 seconds to run and result in a poor UX. You can often fine-tune a faster model and get output with the same or better quality Hallucination: A prompt-based approach without chaining can be more prone to hallucination because there often isn’t enough context to teach the model to provide concise, truthful answers Undifferentiated results: Over time, the competitive advantage your prompt provides will go to zero as foundation models continue to improve. A fine-tuned model trained on proprietary data is needed to provide proprietary results

If these problems sound familiar to you, you might consider fine-tuning. There are other techniques that can help with a subset of these problems (like vector search, caching, and prompt chaining), all of which have their own pros / cons (we’ll cover in future posts!) but we’ve found fine-tuning to generally be the most impactful and widely applicable.

As an example, one of our customers got great results on a use case where we moved from prompts to fine-tuning —&gt; costs went down by 94%, while improving accuracy and significantly decreasing latency.

### But wait, what is fine-tuning?

Fine-tuning a language model involves training the model on a smaller, task-specific dataset to adapt it to a particular task or domain. The pre-trained foundation model acts as a starting point, with the weights of the network being further optimized based on the task-specific data. Fine-tuning helps the model better understand the specific context and language patterns of the task it is being fine-tuned for. This is just a short summary – we’re happy to chat more about fine-tuning in detail (mathematical formulae included by request 😁) at any time!

### How can I get started with fine-tuning?

Alright, so you’re sold on wanting to try fine-tuning – great! Here’s how we recommend you go about it (OpenAI fine-tuning):

Collect a large number of high quality prompt/completion pairs: Ideally you already have this data from when your prompt-based model was in production (if you don’t, Vellum can track this data for you). We’ve seen great results with even just 100 rows of training data, but it depends on the use-case. Clean the prompts: Remove the instructions and keep only the inputs. Convert data to JSONL file format If you have a classification use case, split off training &amp; validation sets (we suggest an 80/20 split) so you can test the fine-tuned model’s performance. Try various combinations of hyperparameters: Test different foundation models. For each foundation model, try different hyperparameters like learning rate, number of epochs until you find the best cost, quality &amp; latency tradeoff for your use case. If you want to be thorough, you will likely be comparing at least 8-10 options in this step. Remember, each fine-tuning task can take 20+ minutes to run, so be prepared! ‍ Once you decide on your new model, remember to not use your original prompt but only pass inputs to the fine-tuned model.

To protect against data drift and ensure your model is getting better over time, we recommend repeating this process regularly as your dataset grows.

### Looking for an easier way?

Fine-tuning LLMs is an incredibly powerful strategy, but as you may have observed, the steps to do it well are time-consuming. The process requires collecting &amp; labeling high quality training data, trying different model &amp; hyper-parameter combinations, evaluating the quality of outputs, and retraining as new data comes up. This stuff takes time and usually, lots of custom code!

At Vellum, we’re firm believers in the power of fine-tuning and want to help make it incredibly easy to manage. We love this stuff and are always happy to chat to provide tailored advice on your fine-tuning approach. We also offer Vellum Optimize, an LLM Ops platform that simplifies and automates much of the fine-tuning busywork for you.
