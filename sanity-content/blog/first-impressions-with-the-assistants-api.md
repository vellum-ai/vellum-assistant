---
title: "First impressions with the Assistants API"
slug: "first-impressions-with-the-assistants-api"
excerpt: "Assistants API: Easy assistant setup with memory management - but what's under the hood?"
metaDescription: "OpenAI's Assistants API makes assistant creation easy, with built in Retrieval, tools and memory management with Threads. But what's under the hood, and how much control do you have?"
metaTitle: "First impressions with the Assistants API"
publishedAt: "2023-11-16T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build powerful and reliable LLM assistants. "
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Semantic Search", "Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/2bf10c9015b5695ef3faced19bc437e55ac946a5-1107x762.png"
---

The Assistants API is user-friendly as it simplifies the RAG pipeline based on best practices from ChatGPT. It also handles memory management automatically.

If you want to spin up a chatbot, this might be your fastest and easiest way to do so.

OpenAI has done an excellent job in streamlining the process, making it accessible for developers new to AI to build their own assistants in just a few hours.

But what is actually happening under the hood? How much of the process can you control?

And what should you know before using the API?

We try to answer all of these questions and provide more insights below.

‍

Knowledge Retrieval

The built-in Retrieval tool augments the LLM with knowledge from outside its model. Once a file is uploaded and passed to the Assistant, OpenAI automates the whole RAG process that was usually custom-built by developers.

They automatically chunk your documents, index and store the embeddings, and implement vector search to retrieve relevant content to answer user queries.

This is useful because it will save a lot of time, as you rely on OpenAI to make those decisions for you.

However, it can also be limiting because you’ll have little control over the strategies and models used for the retrieval process, especially if they don’t work well for your specific needs and budget.

We explore the underlying models and algorithms, along with the associated costs, in the following section.

### Embedding models / Chunking / Re-ranking

When it comes to text embedding models, OpenAI uses their best one, the adda-02 model. It can perform well on specific tasks, and it's definitely worth testing it out.

However, it's not the best one. It currently ranks on the 20th place on the MTEB benchmarks .

Other models like Instructor XL are SOTA on 70 tasks and are open-sourced. You are not able to use them with the Assistants API, and you’ll need a custom setup to test them out.

Regarding the chunking and re-ranking algorithm there is no available information on how it’s currently done under the hood.

### Costs

Retrieval is priced at $0.20/GB per assistant per day, and you can only upload 20 files which can be limiting for some use-cases. If not managed well, this can get very expensive.

However, if your information is provided in text or CSV format, you can compress a large amount of content—potentially tens of thousands of pages—into a file smaller than 10 megabytes. Therefore, the limit of 20 files can appear arbitrary.

‍

Memory Management

The Threads functionality turned the Chat Completions API from a "stateless" model (no memory) to a "stateful" one. Previous messages can be stored, eliminating the need for developers to implement custom memory management techniques.

This was the last puzzle piece that was missing from the previous Chat Completions API. Now you can capture recent conversations and provide better answers.

Bellow we look into how Threads work, memory techniques and tokens.

### Entire conversation is re-send to the server with each user interaction

The current memory setup of the Assistant requires sending the entire thread to a vector database each time a new message is added.

This can lead to exploding costs and high-latency. Many developers are already flagging this issue in the OpenAI forum. Some report that they got charged over $3 for summarizing a 90 page (~55K token) pdf file.

Threads also don’t have a size limit, and you can pass as many messages as you want to a Thread. Imagine how expensive this can get with 128K context window.

To manage this, you can programmatically trim or cap the context size (depending on your needs) for pricing to not explode.

### Different chatbots require custom memory techniques

When you’re building a chatbot, you need to be able to use a different memory technique that’s custom to your use-case.

Do you expect your user interactions to be short, and you want to store everything in a vector db? Or maybe you want to buffer the most recent messages and save on costs?

There are multiple memory techniques that we outline here and we don’t think that one memory technique like Threads will fit into every use-case.

### No token breakdown for the Assistants API

Another thing that’s currently unclear is how many tokens is the assistant using and for which actions across retrieval, tools, generation. There is no documentation on this, and we’ll update the post as that info becomes available.

‍

Function Calling

Function calling was improved in terms of accuracy so now GPT-4 Turbo is more likely to return the right function parameters.

But more importantly you can now pass one message requesting multiple actions , for example: “find the location and give me X near by restaurants”. This new update allows multiple actions to be executed in parallel, to avoid additional round-trips calling the API.

However, you need to set up custom triggers for when a function call should be executed.

### Understanding user intents is critical for assistants

To accurately capture the intended purpose, it is crucial to have better control whether a function should be executed.

Should we fire up a function call to an external API or should the assistant just answer the message from our knowledge db?

This is currently done automatically by the Assistants API, but for specific use-cases you need to able to control this with certain triggers or rules.

These can be keyword detection, intent handlers, user preferences etc. Each method has its own advantages and complexities, and the best approach depends on the specific requirements and capabilities of your assistant.

### Function calling and tokens

Under the hood, functions are injected into the system message in a syntax the model has been trained on. This means functions count against the model's context limit and are billed as input tokens.

To minimize the number of tokens, you can instruct the LLM to be concise, and possibly add “Only return the function call, and do not output anything else”. You may need to do more experiments with your prompts to see which one will get you the best answer.

‍

Code Interpreter

You can also enable the Code Interpreter tool right in the playground UI, and that option allows your Assistant to solve challenging code problems, analyze data, create charts, edit files, perform math, etc.

Let’s look at which languages are supported, and how is the cost calculated for this tool.

### Code Interpreter: Python Language Only

The code interpreter can only write and run Python code, and it supports a finite list of libraries. You can’t add external libraries, and since it doesn’t have access to the internet you can’t use some of the packages that are included.

If you need support for other languages, including Python, C++, Java, PHP, Typescript (Javascript), C#, Bash and more, a great alternative is using Code LLama . It’s also open-sourced and free for commercial use.

### Code Interpreter cost in the Assistants API

Currently it it costs $0.03 / session, and the tool is free until 11/17/2023.

But what counts as a session?

Here’s the official explanation from OpenAI: If your assistant calls Code Interpreter simultaneously in two different threads, this would create two Code Interpreter sessions (2 * $0.03). Each session is active by default for one hour, which means that you would only pay this fee once if your user keeps giving instructions to Code Interpreter in the same thread for up to one hour.

If you run multiple threads per hour, and this is starting to increase your spending, you can always revert to using open-sourced code generation LLMs like CodeLlama , which is SOTA on publicly available LLMs on coding tasks.

‍

Final thoughts

There are a lot of complexities that go into building a chatbot.

For example, collaboration might be key for specific teams, where you’d need to bring on a non-technical person to prototype with prompts before they’re pushed into production.

Then, for some use-cases we’ve seen people do much better in terms of cost, latency and quality with other commercial models like PaLM or Claude, or open-sourced like Llama. With the Assistant API you’re limited to only using OpenAI’s models.

Finally, building a chatbot for production often requires more control over the setup, and the Assistant API might be useful for prototyping and spinning up MVP chatbots.

If you want more control over the retrieval processes, the ability to prototype with various prompts/models, collaborate with your team, and have better oversight over model completions, tokens, cost, and latency - we can help you.

Vellum has the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production.

You can take a look at our use-cases , or book a call to talk with someone from our team.

## Table of Contents

Retrieval Memory Management Function calling Code Interpreter Final Thoughts
