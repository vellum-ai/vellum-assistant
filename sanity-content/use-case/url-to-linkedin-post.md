---
title: "URL to Linkedin post"
slug: "url-to-linkedin-post"
seoTitle: "URL to Linkedin post"
description: "This workflow extracts content from a URL, generates a LinkedIn post, and automatically refines it to ensure top quality."
shortDescription: "Extract content from article and generate a Linkedin post."
publicWorkflowTag: "571d26be-61bb-428a-95ba-ef545ca91f53"
industry: "Marketing"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/36394fe4519ce8a01ac68ec845099695089c1703-1344x896.png"
---

## Workflow Nodes

### Step audience: Audience (Input)

### Step writing_style: Writing style (Input)

### Step url_to_extract: UrlToExtract (Input)

### Step 1: Extract data

This node runs a script to extract content from the provided URL.

### Step 2: Generating first draft

This node uses LLMs to generate the first draft.

### Step 3: Evaluator

This node uses LLM-as-a-judge to evaluate whether the first draft passes the set criteria.

### Step 4: Repeat until the criteria are met

This workflow will keep generating new drafts until the Evaluator says that the post is well written (criteria is met).

### Step output: Linkedin post (Output)

Ever thought about how AI models tackle complex problems? OpenAI's latest versions, o1 and o1 mini, are shaking things up by mimicking how humans approach difficult tasks. These models aren't just quick responders; they take a moment to 'think' before answering, especially excelling in math and coding challenges. 🧠

Here's the intriguing part: OpenAI o1 significantly outperforms GPT-4o in handling "jailbreaks," making it four times more resilient. This advanced capability stretches across various fields such as genomics, economics, and quantum physics, hinting at transformative applications.

However, this power comes with a catch—latency. The o1 models are considerably slower, sometimes taking minutes to generate a response. And while the o1 mini is designed for developers, offering impressive coding skills at a fraction of the cost, it still lags behind in speed compared to its predecessor, GPT-4o.

Curious about how these models stack up against real-world tasks? The article dives deeper into benchmark comparisons and expert reviews. If you're navigating the world of AI, choosing between speed and depth might be your next challenge! Check out the full analysis for more insights. 📈

## Tools

- Data Extraction
- Chat

## AI Tasks

- **Data transformation**
- **Content Generation**

## Customizations

1/ Add your style and tone

2/ Integrate with your system

3/ Use out of box RAG

4/ Add custom evaluation metrics

5/ Use different models
