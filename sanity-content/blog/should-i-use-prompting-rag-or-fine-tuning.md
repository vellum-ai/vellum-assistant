---
title: "Should I use Prompting, RAG or Fine-tuning?"
slug: "should-i-use-prompting-rag-or-fine-tuning"
excerpt: "Rag vs Fine-Tuning vs Prompt Engineering: Learn how to pick which one is the best option for your use-case."
metaDescription: "Rag vs fine tuning vs Prompt Engineering: Learn how to pick which one is the best option for your use-case, how to use it, and the benefits from it."
metaTitle: "Should I use Prompting, RAG or Fine-tuning?"
publishedAt: "2023-08-31T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Visually build production-grade AI apps."
authors: ["Akash Sharma"]
category: "Guides"
tags: ["Prompt Engineering", "Semantic Search", "Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/f159cac45b259fe3626e87425d54c8c0557647f3-1107x762.png"
---

Interest in fine-tuning is on the rise after OpenAI’s recent announcement about fine-tuning on GPT-3.5 Turbo . We had written a blog last month about why fine-tuning is relevant again and as mentioned there fine-tuning offers numerous benefits for certain kinds of tasks.

Fine-tuning, however, is just one approach for getting a language model to provide results. When talking to users trying to use LLMs in production, there is often a question of choosing between writing a simple prompt, using Retrieval Augmented Generation (RAG) or fine tuning. Sometimes RAG can be used in addition to fine tuning for your application which makes this question even more interesting.

Ultimately, it comes down to the details of your specific use case, availability of training data and your criteria on cost, quality, latency and privacy. In this post, we first describe what these approaches are and then share some questions you can ask to determine the right approach for your task.

## What is prompting / prompt engineering?

Prompting is a method used in NLP to steer a language model's behavior by supplying it with specific cues or instructions. This technique allows a user to manipulate the model's output to align with their objectives. Prompting is achieved by altering the model's input, guiding it to produce text that is coherent, relevant, and purposeful. The complexity of the prompts can range from a simple phrase to detailed instructions, based on the task's needs. The art of creating an effective prompt for a specific use case is known as prompt engineering.

## What is fine tuning?

Fine-tuning is a popular technique in NLP that adapts a pre-trained language model to a specific task or domain. It leverages the knowledge from a larger pre-trained model and trains it further on a smaller, task-specific dataset, enabling the model to perform better on the targeted task.

The process involves two steps: selecting a pre-trained language model that has been trained on diverse text sources, and then further training this model on a domain-specific dataset. This additional training allows the model to adapt to the specific patterns and nuances of the target task, enhancing its performance on task-specific applications in terms of quality, cost, and latency.

## What is RAG (Retrieval Augmented Generation)?

Foundation models, trained on a vast corpus of text, lack access to proprietary data and operate solely on given prompts. If your LLM application needs to utilize proprietary data or prior user conversations that exceed the LLM's context window, Retrieval Augmented Generation (RAG) becomes essential.

Retrieval augmentation operates in two stages. First, it uses an 'embedding model' to vectorize the input query and database documents, enabling semantic similarity comparisons. Then, it measures the 'distance' between the input query vector and document vectors to extract the most relevant documents. Finally, a generative model uses the prompt, input query, and retrieved documents to generate a contextually appropriate response.

## How should I pick an approach?

We will go through a series of questions which will help you choose the right approach for your use case. You should view these questions in order. For instance, proceed to Question 2 only if the answer to Question 1 is No. Keep going until you find the answer for your situation.

### Question 1: Is the task standardized &amp; do I have sufficient training data?

Example: Extracting details of a bank statement in JSON format from a PDF. Training data is available through historical records.

You would typically need 1000s of rows of training data for this fine tuning to start providing results, but more is better.

If the answer to this question is yes, you should strongly consider fine tuning an open source model (like MPT-7b or Llama-2). A fine-tuned open source model can usually outperform a prompt based approach on quality, cost and latency. Details of how to fine-tune a model and make sure it remains relevant can be found in one of our prior posts here .

### Question 2: Does your use case mostly rely on the model’s pre-trained knowledge?

Example: Generate sales emails given some details about the sender, recipient and company

If the answer to this question is yes, you will be best suited with a prompt based approach . Start by coming up with a prompt for a powerful model like OpenAI’s GPT-4 or Anthropic’s Claude 2. Run through multiple test cases with an appropriate evaluation metric given your use case (more details here ). Then iterate on your prompt across other models like GPT-3.5, Claude Instant or open source models like Llama-2 until you settle on a prompt/model combination that meets your quality, cost and latency criteria.

### Question 3: Does the additional context needed by the model exceed the model’s context window?

Example: Q&amp;A chatbot from your support help center documentation

If the answer to this question is yes AND you don’t need the full context to provide a response , Retrieval Augmented Generation (RAG) is the the preferred approach . Upload documents to an index on a Vector Database (like Pinecone, Weaviate, Milvus, Chroma etc.), choose the right embedding model for your use case (text-embeddings-ada is not always the best 😃), try out different chunking strategies for the best retrieval. Once the context is in the prompt, make sure to follow the same prompt engineering tips we outlined above to confirm your application is providing the desired results.

Note: there’s a number of tasks that require a large amount of context AND all of it is needed to provide a generation. An example of this is splitting a 100 page document into logical boundaries. In cases like this you would need a model with a large context window which accepts the whole document as context. The largest context windows available in models as of August 2023 are 100k tokens (~150 pages) for Anthropic Claude and 32k tokens (~50 pages) for OpenAI’s GPT-4

### Bonus Question: The task is standardized, and the model needs to have access to proprietary data. What should I do?

Example: You’ve been running RAG for a long time and want to minimize hallucinations or reduce cost/latency

This is one of those cases where RAG can be used in conjunction with fine-tuning. Once you have a high quality input-output dataset (input will include RAG results, and output is the correct answer), you can fine tune an open source model to identify the correct context from search results. At run-time, your fine-tuned model would still take search results from the Vector Database but will not require too much additional context to provide the desired output.

# How to leverage this while building your LLM application

As you can see, the approach to build your LLM application depends a lot on your specific task.

Multiple LLM calls can be combined together and your application can have prompts, RAG &amp; fine-tuned models all in there.

If you’d like tailored advice on your use case and want to try these approaches in our application without building much custom code, sign up for a 14-day free trial of Vellum here . We’re excited to see what you end up building with LLMs!
