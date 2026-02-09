---
title: "E-commerce shopping agent"
slug: "e-commerce-shopping-agent"
shortDescription: "Check order status, manage shopping carts and process returns."
heroIntroParagraph: "Support my customers on autopilot"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/1d5154c1-90cd-4f4d-b19a-4479e311185b?releaseTag=LATEST"
workflowId: "1d5154c1-90cd-4f4d-b19a-4479e311185b?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-09-18T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "e-Commerce"
categoryTags: ["AI Agents", "Data extraction"]
createdByTeam: "Anita Kirkovska"
---

## Content

This workflow creates a e-commerce support agent that assists customers with various e-commerce tasks, such as checking order status, managing shopping carts, and processing returns. It leverages AI to provide real-time responses based on user queries and actions.

‍

## How it Works / How to Build It

Inputs : The workflow starts with the Inputs class, which captures the user's chat history as a list of ChatMessage objects. MerchantAgent Node : The MerchantAgent node processes user queries. It uses a predefined prompt to guide the AI's responses, ensuring it behaves like a helpful support agent. FinalOutput Node : The output from the MerchantAgent is passed to the FinalOutput node, which formats the response for the user. Functions : The workflow includes several functions for specific tasks, such as check_order_status , manage_cart , process_checkout , and create_support_ticket . These functions handle the logic for each task and return relevant information.

## What You Can Use This For

Customer support for e-commerce platforms Order tracking and status inquiries Cart management (adding/removing items) Processing returns and refunds Creating support tickets for complex issues

## Prerequisites

Vellum account Access to the e-commerce product catalog Basic understanding of customer support workflows

## How to Set It Up

Clone the workflow template in your Vellum account. Ensure you have the necessary APIs and data sources connected (e.g., product catalog, order management system). Customize the MerchantAgent prompt to fit your brand's voice and support policies. Test the workflow with sample queries to ensure all functions (like check_order_status and process_checkout ) are working correctly. Deploy the workflow and integrate it with your customer support channels (e.g., website chat, email).
