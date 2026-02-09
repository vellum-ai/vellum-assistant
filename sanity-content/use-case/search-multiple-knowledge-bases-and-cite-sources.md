---
title: "Q&A across knowledge bases"
slug: "search-multiple-knowledge-bases-and-cite-sources"
seoTitle: "Search Multiple Knowledge Bases and Cite Sources"
description: "Process documents with OCR, test different search strategies, and orchestrate multiple agents to work together to answer questions."
shortDescription: "Ask questions and retrieve context from multiple vector databases."
publicWorkflowTag: "788489db-7020-4167-b010-96499f7dd102"
industry: "SaaS"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/a04d6a9248a8d8e6be98c0ceae71eaa1464e6c58-1344x896.png"
---

## Workflow Nodes

### Step 1: Document Search

Look for relevant context on multiple Document Indexes in parallel to reduce latency.

### Step Question: Question (Input)

User passes question

### Step 2: Support Agents

We feed context from each Search result to different agents and have them answer the user’s question as well as possible.

### Step 3: Supervisor Agent

We let a Supervisor Agent see the user’s original question and each of the Support Agent’s responses. The Supervisor picks the best response, if any.

### Response (Output)

To pass inputs into an API Node, you can use URL parameters or a JSON body. For URL parameters, you can define them directly in the URL field of the API Node. For a JSON body, you can specify the body content in the designated field of the API Node.

For more detailed instructions, you can refer to the [Node Types Help Doc](https://docs.vellum.ai/help/node-types).

‍

## Tools

- RAG
- Agent
- Chat
- Evaluator

## AI Tasks

- **Chatbot**

## Customizations

1/ Add additional data sources

2/ Use advanced document chunking to process complex PDFs with images, charts, spreadsheets, etc.

3/ Add routing → escalate to humans when no good answer is available

4/ Add out of the box metrics to evaluate the quality of your RAG

5/ Add Tools so your LLMs can perform actions on behalf of your users
