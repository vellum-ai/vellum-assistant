---
title: "How we cut model costs by >90% by swapping LoRA weights dynamically"
slug: "how-we-reduced-cost-of-a-fine-tuned-model-by-90-by-dynamically-swapping-lora-weights"
excerpt: "Dynamically swapping LoRA weights can significantly lower costs of a fine tuned model"
metaDescription: "Read this blog post to learn how dynamically swapping LoRA weights can significantly lower the costs of a fine tuned model for your specific use-case."
metaTitle: "How we cut model costs by >90% by swapping LoRA weights dynamically"
publishedAt: "2023-08-03T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Sidd Seethepalli"]
category: "Guides"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/4448a1b362f6896f741ce3660ae709e08027890d-1107x762.png"
---

tl;dr: We’ve been working on fine tuning of open source models and wanted to share a technique which helped significantly reduce costs of serving specific fine tuned models. This is only possible if you have enough usage to keep a GPU fully utilized.

## Our views on fine tuning

A few weeks ago we wrote a blog on why fine-tuning is making a comeback in the world of LLMs. As a recap, fine-tuning involves training a pre-existing model on a smaller, task-specific dataset to adapt it to a particular task or domain. The foundation model, a pre-trained LLM like Llama-2-7b , serves as the initial starting point. All weights of this network are then further optimized based on the data specific to the task at hand. The result is a model that uses its pre-trained proficiency in general language to become an expert at the specific task. The fine-tuned model has better performance on specific tasks, lower cost &amp;&nbsp;latency, and improved privacy.

We’ve started working on fine tuning these models for our customers and wanted to share some early learnings.

## What is LoRA in the context of fine tuning?

LoRA (Low Rank Adaption of LLMs) is a technique where you only need to add a small number of extra parameters (&lt; 1%) and fine tune those. In the case of this Llama-2-7b model, fewer than 70m parameters would need to be trained. This makes the training process much faster and cheaper, and the model does surprisingly well on most tasks. The end result is we now have a small adapter that can be added to the base model to achieve high performance on the target task. Swapping only the LoRA weights instead of all parameters allows cheaper switching between tasks. Multiple customized models can be created on one GPU and swapped in and out easily.

## How LoRA can help reduce costs if you have multiple tasks

Let’s use an analogy inspired by a garden hose. Do you recall seeing a garden hose which can take various adapters like a regular stream, a jet, a cone, a mist, a shower, etc.? The same garden hose can spray water in different ways depending on the adapter you choose. If the total demand for water can be fulfilled by the water going to one hose you can serve varying use cases with these adapters (there’s no need for 12 different hoses for 12 use cases).

Dynamically swapping LoRA weights for fine tuned tasks works in a similar way. The foundation model is served on one GPU which is always running and can swap between different LoRA weights as needed. As long as enough models are served that the GPU will always be warm and utilized, cost can be split across all the use cases.

However, for most companies, it’s difficult to fully occupy a GPU’s capacity. Costs add up if your GPU is sitting idle. If you only selectively use the GPU then you have to overcome cold start problem, adding latency of up to 5 minutes (‼️)

This is where an aggregate like Vellum comes in. We serve enough use cases across customers to always keep GPUs occupied. In the low usage limit (i.e., when an individual fine tuned model is not used too much), cost per request goes down by ~99% and additional latency is only 50ms.

## Next steps

If you’re interested in exploring a lower cost alternative to your current fine tuned model or prompt based model please reach out to me at akash@vellum.ai . At Vellum we abstract away the complexities with training models and make them extremely easy to use.
