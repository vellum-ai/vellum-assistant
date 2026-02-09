---
title: "Customer support agent"
slug: "customer-support-agent"
shortDescription: "Support chatbot that classifies user messages and escalates to a human when needed."
heroIntroParagraph: "Classify requests and escalate in Slack"
prompt: "Create a support chatbot that classifies messages into Billing, Product Help, Account Management, or Escalation, answers from your knowledge base, and for Escalation notifies a chosen {{Slack}} channel and tells the user a human will follow up."
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/a893d000-efe3-4209-b1c1-5aa3912d1bcb?releaseTag=LATEST&condensedNodeView=1&showOpenInVellum=1"
workflowId: "a893d000-efe3-4209-b1c1-5aa3912d1bcb?releaseTag=LATEST&condensedNodeView=1&showOpenInVellum=1"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Customer support"
categoryTags: ["AI Agents", "Customer Service"]
createdByTeam: "Anita Kirkovska"
integrations: ["Vector db", " Slack"]
---

## Prompt

Create a support chatbot that classifies messages into Billing, Product Help, Account Management, or Escalation, answers from your knowledge base, and for Escalation notifies a chosen {{Slack}} channel and tells the user a human will follow up.

## Content

This workflow creates a customer support chatbot that classifies user inquiries and generates appropriate responses. It can escalate urgent issues to a human agent and notify the support team via Slack.

### How this agent works

‍ &nbsp; 1. ClassificationPrompt: This node classifies user messages into categories such as billing, product help, account management, or escalation. It uses a machine learning model to analyze the message and determine the appropriate category. &nbsp; 2. SearchKnowledgeBase: Based on the classification, this node searches a knowledge base for relevant information related to the user's inquiry. &nbsp; 3. GenerateResponse: This node generates a response using the information retrieved from the knowledge base and the user's message. &nbsp; 4. SlackAlertAgent: If the inquiry is classified as an escalation, this node sends an alert to a Slack channel to notify the support team. &nbsp; 5. EscalationResponse: This node provides a standard response to the user, informing them that their request has been escalated. &nbsp; 6. Merge: This node merges the outputs from the GenerateResponse and EscalationResponse nodes. &nbsp; 7. Output: This final node returns the chatbot's response to the user.

### What You Can Use This For

‍ &nbsp; - Customer support teams can handle inquiries more efficiently. &nbsp; - Escalate urgent issues to human agents quickly. &nbsp; - Provide users with immediate responses based on a knowledge base.

### Prerequisites

‍ &nbsp; - Vellum account &nbsp; - Access to a knowledge base with relevant support documents &nbsp; - Slack integration set up for notifications

### How to Set It Up

‍ &nbsp; 1. Clone the workflow template in your Vellum account. &nbsp; 2. Configure the knowledge base connection in the SearchKnowledgeBase node. &nbsp; 3. Set up the Slack integration in the SlackAlertAgent node. &nbsp; 4. Customize the response templates in the GenerateResponse and EscalationResponse nodes as needed. &nbsp; 5. Test the workflow with sample user messages to ensure proper classification and response generation.

‍

## FAQ

#### What does this workflow actually do?

It powers a customer support chatbot that reads a user’s message, figures out what it is about, answers from your knowledge base, and escalates urgent issues to a human with a Slack alert when needed.

#### How does the chatbot know when to escalate to a human?

The ClassificationPrompt node tags each message with a category, including an “escalation” type for urgent or sensitive issues. When a message is tagged for escalation, the SlackAlertAgent sends a notification to your chosen Slack channel and the user gets an escalation response.

#### What types of questions can this handle?

Out of the box it is set up for billing, product help, account management, and escalation. You can add, remove, or rename categories in the ClassificationPrompt node to match your support workflows.

#### How does the chatbot find the right answer?

The SearchKnowledgeBase node looks through your connected knowledge base using the classification and the user’s message. It pulls up to five relevant documents. The GenerateResponse node then uses those documents to write a clear reply.

#### Can I customize the tone and style of the responses?

Yes. You can edit the prompt in the GenerateResponse node to change the tone, length, or format of the answers so they match your brand voice and support guidelines.

#### How does Slack fit into this workflow?

Whenever a message is marked as an escalation, the SlackAlertAgent sends an alert into your chosen Slack channel. Your support team can pick it up there, while the user receives a clear message that a human is taking over.

#### What happens from the user’s point of view during an escalation?

The user sees a standard escalation message from the EscalationResponse node, telling them that their request has been handed off to a human agent and setting the right expectation for next steps.

#### What do I need before I can use this workflow?

You need a Vellum account, a connected knowledge base with your support docs (billing, product, account, etc.), and a Slack integration set up for the SlackAlertAgent node.

#### How do I set this up the first time?

Clone the template in Vellum, hook up your knowledge base in the SearchKnowledgeBase node, configure your Slack channel in the SlackAlertAgent node, adjust classification labels if needed, then test with sample messages before going live.

#### Can I expand this for more teams or use cases?

Yes. You can add more categories in the ClassificationPrompt node, point SearchKnowledgeBase to different document sets, or create separate Slack channels for different teams while reusing the same base workflow.
