---
title: "Customer Support Q&A"
slug: "customer-support-q-a"
seoTitle: "Customer Support Q&A"
description: "Create a bot that searches your documentation in a vector database and integrates with Zapier or Slack to answer customer questions."
shortDescription: "Perform vector search, integrate with Zapier/Slack and answer user questions. "
publicWorkflowTag: "788489db-7020-4167-b010-96499f7dd102"
industry: "SaaS"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/dfa0c490a4e34b58ba3c1b6c6f5a33cf4027bbdb-1344x896.png"
---

## Workflow Nodes

### Step user_question: Question (Input)

### Step 2: Search context

Perform a vector search in the "Help Desk" vector database based on a user's query across multiple data sources.

### Step 3: Summarize

Summarize the output in a conversational format, and answer the user in the preferred channel (e.g. Slack).

### Step 1: Search Context from previous questions

Perform a vector search in the "Q&amp;A bank" vector database that stores all previously asked user queries and answers.

### Step output: Answer query (Output)

It looks like you're asking about passing inputs into an API node. I recommend checking out our Help Doc on that topic here: [API Node Tips](https://docs.vellum.ai/help-center/workflows/node-types#api-node-tips). If you have any more questions, feel free to ask!

## Tools

- Data Extraction
- RAG
- Integration
- Memory
- Parser

## AI Tasks

- **Chatbot**

## Customizations

1/ Integrate multiple vector dbs

2/ Try different models

3/ Integrate business logic

4/ Perform evaluations

5/ Debug and test in production
