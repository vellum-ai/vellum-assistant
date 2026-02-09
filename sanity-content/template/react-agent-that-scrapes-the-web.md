---
title: "ReAct agent for web search and page scraping"
slug: "react-agent-that-scrapes-the-web"
shortDescription: "Gather information from the internet and provide responses with embedded citations."
heroIntroParagraph: "This ReAct agent can perform web searches and scrape web pages based on user queries. It allows users to interact with the agent, which gathers information from the internet and provides responses with citations."
onboardingUrl: "http://app.vellum.ai/onboarding/open-in-vellum/32849cc5-51bd-481c-925e-3bd9791caa26?releaseTag=LATEST"
workflowId: "32849cc5-51bd-481c-925e-3bd9791caa26"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Marketing"
categoryTags: ["AI Agents", "Web Search", "Page scraping"]
createdByTeam: "Aaron Levin"
---

## Content

### How it Works / How to Build It

AgentNode : This is the main node that processes user input and generates responses. It uses a prompt to instruct the AI to act as a helpful support bot. HasFunctionCalls : This node checks if the agent's response includes any function calls (like web searches or page scrapes). It routes the workflow based on whether function calls are present. InvokeFunctions : If function calls are detected, this node executes them. It can handle different types of function calls, such as google_search or page_scrape . AccumulateChatHistory : This node collects the chat history, including the assistant's messages and results from any invoked functions, to maintain context for the conversation. FinalOutput : This node formats the final response from the agent, including any information gathered from the web.

### What You Can Use This For

Customer support teams can use this to provide instant answers to user queries by searching the web. Research teams can gather information from various sources quickly. Content creators can find relevant data and citations for their work.

### Prerequisites

Vellum account Access to web scraping and search APIs (e.g., SERP API) Basic understanding of how to set up workflows in Vellum

### How to Set It Up

Clone the workflow template in your Vellum account. Configure the AgentNode with your desired prompt settings. Set up the InvokeFunctions node with the necessary API keys for web scraping and search. Connect the AccumulateChatHistory node to ensure chat context is maintained. Test the workflow by inputting sample queries and verifying the responses.
