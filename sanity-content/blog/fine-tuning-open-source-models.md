---
title: "Fine-tuning open source models: why is it relevant now?"
slug: "fine-tuning-open-source-models"
excerpt: "Why fine tuning is now relevant with open source models"
metaDescription: "Learn what is fine tuning, how it works, and the pros and cons of LLM fine tuning with open source models."
metaTitle: "Fine-tuning open source models: why is it relevant now?"
publishedAt: "2023-07-20T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Akash Sharma"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/96097d5db52b86f5f2bb298a79cab2d2e54c9504-1107x762.png"
---

Five months ago, we wrote a blog on when fine tuning may be a good idea for your LLM application - there were clear cost and latency benefits for specialized tasks. However, 5 months is a long time in the world of LLMs! Since then, retrieval augmented generation has been far more popular and fine-tuning isn’t supported on the latest instruction tuned models from OpenAI or Anthropic either. More recently though, fine tuning has started to make a comeback coinciding with the rise of open source models. New open source models are being released quickly, with the hotly anticipated Llama 2 coming out yesterday (other top models are Falcon-40b , MPT-30b ). And these models are very well suited for fine-tuning.

## Why You Should Fine-Tune

"Prompt and prosper" may seem like the ideal mantra for working with LLMs, but eventually you'll find that relying exclusively on prompts can paint you into a corner. The initial ease of using prompts often gives way to challenges that become more pronounced over time. High costs, sub-optimal handling of edge cases, limited personalization, high latency, a tendency towards hallucination, and the gradual erosion of your competitive advantage are all potential issues that can take the sheen off your LLM deployment.

Enter fine-tuning: a method that enables you to optimize your LLMs for specific tasks, resulting in lower costs, improved accuracy, and lower latency. In the following sections, we'll explore fine tuning more, demonstrating how this approach is likely to be an important approach moving forward.

## What is Fine-Tuning?

In the realm of AI (not just LLMs), fine-tuning involves training a pre-existing model on a smaller, task-specific dataset to adapt it to a particular task or domain.

The foundation model, a pre-trained LLM, serves as the initial starting point. The weights of this network are then further optimized based on the data specific to the task at hand. This process allows the model to develop a nuanced understanding of the particular context and language patterns it's being fine-tuned for.

The result is a model that uses its pre-trained proficiency in general language to become an expert in your specific application, thanks to the additional layer of learning imparted through fine-tuning. In essence, fine-tuning is a process of specialization that enhances the general skills of a language model to perform better on task-specific applications.

## The Resurgence of Fine-Tuning with Open Source Models

The AI industry is moving fast, and new developments constantly make us rethink our strategies. Recently released high quality open source models are doing just that.&nbsp;

The reason for this renewed interest lies in their performance. Open source models are showing potential that can be harnessed using fine-tuning, making them an attractive choice for LLM applications. By employing your own data, you can tune these models to align better with your specific needs. This move not only adds an extra layer of specialization to the model but also empowers you to maintain control of your AI strategy.

## Advantages and Disadvantages of Fine-Tuning

Before we get too deep into fine-tuning, it's crucial to understand its benefits and potential drawbacks. Later we’ll share a step by step guide to fine tuning.

### Benefits of Fine-Tuning

Improved performance on specific tasks: By tailoring the model to your specific requirements, fine-tuning can result in a significant performance boost. Lower cost / latency: As the model becomes more efficient at its tasks, it uses fewer resources, leading to cost savings (no need to send the same prompt to the model in each request) Enhanced privacy: Since fine-tuning uses your own data and is deployed by you, it adds an extra layer of privacy to your operations.

However, there are also some challenges to keep in mind.

### Challenges with Fine-Tuning

Time consuming: Fine-tuning a model requires a significant time investment. This includes training and optimizing time for the model, in addition to determining the best practices and techniques for your approach ‍ Specific expertise needed: Fine tuning is a difficult task (often why users turn to prompting despite lower performances for specific tasks). Achieving optimal results typically requires a considerable amount of knowledge and expertise in parsing data, training, inference techniques, etc.&nbsp; ‍ Infrastructure overhead: Finetuning an LLM on a large dataset can be a costly process, often requiring a complex setup and expensive GPU resources ‍ Lack of contextual knowledge: Finetuned models are trained to perform very specific tasks and often lack the versatility demonstrated by closed source models like GPT-4

## A Step-by-Step Guide to Fine-Tuning Models

Embarking on the fine-tuning journey might seem daunting, but it doesn't have to be. Here's a straightforward guide to set you on the right path:

Collect a substantial amount of quality data : Begin with collecting high-quality prompt and completion pairs. The better your data quality, the better your fine-tuned model will be. If you are working with prompts, store inputs and outputs according to Terms of Service. This data is invaluable and can later be used for fine-tuning your model. The better your data quality, the better your fine-tuned model will be. The amount of data needed to construct a well-performing model&nbsp; is dependent on the use case and type of data.&nbsp; Clean your data : Get rid of the instructions and keep only the inputs. The goal here is to have clean, structured data. Split your dataset : Split your dataset into training and validation sets (we suggest considering how much data you actually need for validation here instead of an arbitrary 80/20 split) to evaluate the performance of your fine-tuned model. Experiment with hyper-parameters : Test different foundation models and play around with hyper-parameters like learning rate, number of epochs, etc. The goal is to find the best cost, quality, and latency tradeoff for your specific use case. Fine-tuning : Armed with your optimized parameters, it's time to fine-tune. Be prepared - each fine-tuning task can take some time to run. Use your fine-tuned model : Once fine-tuned, use your model by passing only inputs and not the original prompts. Regularly update your model : To guard against data drift and ensure your model improves over time, repeat this process as your dataset grows and as new foundation models are released.

## Considerations to Keep in Mind

Fine-tuning is a potent tool, but like any tool, its effectiveness depends on how well you wield it. Here are some considerations to keep in mind:

Overfitting : Be wary of overfitting - a common pitfall where the model becomes too attuned to the training data and performs poorly on unseen data. Quality of the dataset : The quality of your dataset plays a pivotal role in determining the efficacy of the fine-tuned model. Hyper-parameters : Choosing the right hyper-parameters can make or break your fine-tuning process. Privacy and Security Implications : Ensuring the privacy of your data during the fine-tuning process is crucial. Ensure that proper data handling and security protocols are in place.

## Conclusion and Next Steps

Fine-tuning models can provide significant benefits and solve many of the challenges associated with using large language models. Despite some potential pitfalls, with the right approach and considerations, fine-tuning can be a robust tool in your AI arsenal.

To delve even deeper into fine-tuning, consider exploring more resources on the topic, such as online courses, tutorials, and research papers. And remember, you're not alone on this journey. Need help getting started or fine-tuning your model? Feel free to reach out to me at akash@vellum.ai
