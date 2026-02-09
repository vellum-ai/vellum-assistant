---
title: "SOAP notes from transcripts"
slug: "soap-notes-from-transcripts"
seoTitle: "Generate SOAP Notes from Patient Transcripts"
description: "Chain together Prompts to optimally produce SOAP notes from your patient transcripts."
shortDescription: "Chain prompts to produce SOAP notes from transcripts."
publicWorkflowTag: "2d0c9f3a-f9d2-418c-a4ff-eae4416b7471"
industry: "Healthcare"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/4e48518b0958c5ac5fa64174dca332b7c641b038-1344x896.png"
---

## Workflow Nodes

### Step Transcript: Transcript (Input)

### Step 1: Extract Assesment

We feed the transcript into two Prompt Nodes and generate our Subjective and Objective.

### Step 2: Create Assesment

Use the analysis to create an assesment and a plan in the specified format, specifically including details like recommended medications, lifestyle changes, diagnostic tests, and when to return back.

### Step 3: Evaluator

Repeat generating plans until quality threshold is met. Once the criteria is satisfied output the SOAP note.

## Tools

- Data Extraction
- Evaluator

## AI Tasks

- **Data transformation**

## Customizations

1/ Add your style and tone

2/ Use out of box RAG to leverage physicians’ / clinics’ strategic preferences

3/ Use API Nodes to check drug interactions on the web

4/ Create a loop to iterate until passing a quality Metric

5/ Use Semantic Similarity Metrics to automate quality assessment at scale
