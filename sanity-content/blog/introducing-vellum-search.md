---
title: "Introducing Vellum Search"
slug: "introducing-vellum-search"
excerpt: "Vellum Search, the latest addition to our platform helps companies use proprietary data in LLM applications"
metaDescription: "Vellum Search, the latest addition to our platform helps companies use proprietary data and their LLM applications"
metaTitle: "Introducing Vellum Search"
publishedAt: "2023-04-12T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today"
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/96097d5db52b86f5f2bb298a79cab2d2e54c9504-1107x762.png"
---

TLDR: We’re launching Vellum Search , a document retrieval system to enable LLMs to use your company specific data in production. Companies take weeks to build this infrastructure today because of token window limitation from model providers. Search is tightly integrated with the rest of our platform, comes with smart defaults, but also supports maximal configuration at each step of the process.

‍

This is an exciting announcement! Since we first announced Vellum, we've had the opportunity to work with 1000s of people using LLMs in production. The concepts we shared in our original blog still resonate with most people but, over time, we realized that our users face a whole different problem before they can even consider using LLMs: information retrieval of company specific data. Based on this feedback we're launching a new part of our platform: Vellum&nbsp;Search. This post shares more about Vellum Search, please reach out if this resonates with you!

When your LLM use-case requires factually accurate responses based on a proprietary corpus of text (i.e. company-specific information usually not present in foundation models), it’s best-practice to set up a pipeline that

Ingests each “document” from your knowledge base Split each document into smaller chunks Run each chunk through an embedding model Store the resulting embeddings in a vector database (like Pinecone or Weaviate); then finally Given a user-submitted query, perform a hybrid-search at run-time and include the results in your LLM prompt so that it can synthesize an answer

You can either spend days-to-weeks setting up a naïve implementation of this infrastructure yourself OR use Vellum’s managed Search product, which takes just a few minutes to set up, &nbsp;instills best-practices at each step along the way, and is tightly integrated with the rest of our AI developer tools. Here’s a comment from our Hacker News launch which summarizes the commons pains of going with the DIY approach:

![](https://cdn.sanity.io/images/ghjnhoi4/production/fa07a0acd63a68a78a89c6abb83e50879cb5237a-1418x294.png)

## Why Search is a Critical Piece of the LLM Stack

When LLMs need to answer questions factually, without hallucinations, it’s best to provide them the relevant context in the prompt and instruct them to answer just from this context. Easy enough, except the challenge comes when the corpus of text is larger than the token limit of the model. OpenAI is launching a 32k token window (50 pages) version of GPT-4 soon, but filling out those 32k tokens will cost a hefty $1.92 per request 😅 (not to mention, the more tokens you include, the slower the request!).

The solution here is document retrieval via embeddings. Embedding models allow for retrieval based on semantic similarity, which enables the inclusion of only the most relevant chunks of a document into the prompt at run time. This opens up a large number of potential LLM use-cases — here are just a few examples of how our Search product has helped customers in production already:

Support chatbot to answer product questions for a cosmetic brand based on detailed product documentation Internal chatbot to questions based on legal documents with citations to specific cases Agent assist for support agents at hotel chains to answer guest questions (e.g., where is the fitness center? what time is checkout? can you make this reservation for me?) Sales / customer support reps at an insurance company can ask a chatbot about coverage-related questions instead of making a ticket for internal underwriters

## Introducing Vellum Search

LLM use-cases that require document retrieval can be set up within 10 minutes when using Vellum Search, Playground and Manage. Vellum offers tried-and-true defaults to get started quickly, but also exposes advanced configuration for those that want to get in the weeds and experiment. Here’s a step by step guide of how it works:

Step 1 (1 minute): Create a document index (collection of documents which will be queried together at run-time), upload documents either through our API endpoint or our UI.

Step 2 (2 minutes): Once the documents are indexed using your chosen embedding model and chunking strategy, they are stored in a vector database and can be queried through our search API. Choose the number of chunks you want returned.

Step 3 (5 minutes): Go to Vellum Playground, start with our predefined prompt templates, do some prompt engineering, add the relevant chunks to your test cases and confirm the LLM is providing reasonable results.

You can see an interactive walkthrough of these steps here

‍

## Why use Vellum for Document Retrieval?

Our philosophy for document retrieval is to abstract away complex infrastructure, provide smart defaults, and support maximal configuration at each step of the process.

We’ve seen hundreds of people sweat the details on which embedding models to try, what chunking strategy to use, what vector db to implement etc. Some of these questions matter a lot (choice of embedding model), others less so (choice of vector db). Even learning what decisions you should be making can be burdensome!

At the end of the day, document retrieval is just another (albeit critical!) piece of the Al tech stack. With Vellum, document retrieval is tightly integrated into the rest of our AI developer platform so that you can quickly see the holistic impact of how changes to your search + prompt &nbsp;effect your end-user experience.

Our goal is to provide product builders with the tooling needed to create great AI applications in production and Search is a big step towards delivering on that mission!

‍

## Our asks

If you’re interested in using Vellum for any of your LLM use-cases, please reach out to me at akash@vellum.ai or request early access here Subscribe to our and stay tuned for updates from us. We will soon share more technical content about how we created our Search product (e.g., what chunking strategies we tested and built).

‍
