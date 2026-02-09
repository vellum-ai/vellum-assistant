---
title: "Analyze URL and search via Perplexity"
slug: "research-automation-politicians-involved-in-ai"
seoTitle: "Research Automation: Politicians Involved in AI"
description: "Extract politician data from a website then use Perplexity search to identify the ones that are involved in AI. "
shortDescription: "Use Perplexity search to identify politicians that are involved in AI."
publicWorkflowTag: "f47c460c-3129-48f6-a1a2-af6ee9a54a72"
industry: "Just for fun"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/0484372ad3dd9d6cd6ef872c6a41ed828b8e71c0-1344x896.png"
---

## Workflow Nodes

### Step url: URL (Input)

### Step 1: Extract data

This node analyzes the URL content and extracts politician profiles into a JSON object.

### Step 2: Perplexity search

This node will use the JSON object to search for each politician's information in parallel through a Perplexity search integration.

### Step 3: Rank and Summarize

This node will rank all of the people mentioned in the following array in accordance with how directly they care about AI / LLMs.

### Step output: Output [Politicians] (Output)

## Tools

- Data Extraction
- Evaluator
- Integration
- Memory
- Parallel processor
- Web Search

## AI Tasks

- **Data extraction**

## Customizations

1/ Add specific criteria

2/ Integrate with your system

3/ Check multiple URLs

4/ Add custom evaluation metrics

5/ Use different models
