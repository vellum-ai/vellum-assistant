---
title: "Turn LinkedIn Posts into Articles and Push to Notion"
slug: "generate-article-in-notion"
shortDescription: "Convert your best Linkedin posts into long form content."
heroIntroParagraph: "Turn my Linkedin posts into long-form articles"
onboardingUrl: "http://app.vellum.ai/onboarding/open-in-vellum/92256acc-444e-4a09-bb9e-41d32d405a4a?releaseTag=LATEST"
workflowId: "92256acc-444e-4a09-bb9e-41d32d405a4a"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "Content generation"
industry: "Marketing"
categoryTags: ["Content generation"]
createdByTeam: "Anita Kirkovska"
integrations: ["LinkedIn", "Notion"]
---

## Content

This agent transforms a LinkedIn post into a structured article and creates a new page in Notion with the generated content.

‍

### How it Works

Linkedin2Article Node : This node takes the LinkedIn post as input and generates an article based on predefined specifications, including tone, style, and structure. It uses the InlinePromptNode to format the request for the AI model. ToolCallingNode : After the article is generated, this node takes the output from the Linkedin2Article node and prepares to create a new page in Notion. It uses the ToolCallingNode to handle the interaction with the Notion API. FinalOutput Node : This node collects the final output from the ToolCallingNode , which includes the text of the article and any relevant chat history, and prepares it for display or further use.

### What You Can Use This For

Content teams creating articles from social media posts. Marketing departments repurposing LinkedIn content for blogs or newsletters. Developers documenting insights from their LinkedIn activity in Notion.

### Prerequisites

A Vellum account A Composio account Access to the Notion API A LinkedIn post to use as input Optional: Title and page ID for the Notion page

### How to Set It Up

Clone the Workflow : Start by cloning the "Linkedin 2 Article" workflow template in your Vellum account. Configure Inputs : Set the linkedin_post input with the text of your LinkedIn post. Optionally, provide a title and page_id for the Notion page. Connect Nodes : Ensure the nodes are connected in the following order: Linkedin2Article → ToolCallingNode → FinalOutput . Test the Workflow : Run the workflow to generate the article and create the Notion page. Check the output for any errors and adjust inputs as necessary.
