---
title: "Introducing AI Apps: A new interface to interact with AI workflows "
slug: "ai-apps"
excerpt: "AI Apps turn your deployed Workflows into no-code apps your whole team can share to use directly in Vellum."
metaDescription: "AI Apps have been launched to unlock Workflows for your entire org. AI Apps in Vellum provide real-time, no-code workflow executions and seamless sharing."
metaTitle: "Turn Workflows into AI Apps | Vellum AI"
publishedAt: "2025-09-24T00:00:00.000Z"
readTime: "7 min"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Nicolas Zeeb"]
reviewedBy: "Anita Kirkovska"
category: "Product Updates"
tags: ["Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/b9a8f49d2199a0d56311477833580c2c543f8ef8-1192x629.jpg"
---

Today, we’re excited to release AI Apps : customizable UIs that let teams share and run AI workflows as apps in Vellum.

Before, running Workflows outside of Vellum required developers to wire up API calls from external applications or tools.

AI apps eliminates this barrier by letting you test, iterate, and interact with deployed Workflows directly &nbsp;through the AI App interface in Vellum.

Now you and your team can quickly test Workflows with an interface, then roll them out as powerful automations across the org.

👉 Try AI Apps now or book a call to see how others have built a library of AI apps for their whole organization to use.

## Why we need an interface for AI workflows

While the old way of testing Workflows in Vellum through firing off API requests or relying on external tools worked for developers, it left non-technical teammates behind.

AI Apps changes this by providing a streamlined, first-class interface for your whole team to run and iterate on Workflows. You can now seamlessly involve all stakeholders and domain experts to test and run Workflows with an interface that's easy to use and interact with.

Equally important, the AI apps you can build with Vellum can easily adapt to different contexts. Teams can build their own library of agent artifacts and share them across the organization. Workflows can now double as powerful internal productivity AI automations tool that can be used across your whole org through the AI Apps UI.

AI Apps further enable technical and non-technical teams through:

Reduced engineering overhead : No more wiring API calls just to test an AI workflow Faster iteration cycles : Everyone can validate ideas via the UI Organization wide adoption : Anyone can build and share agent artifacts Stakeholder alignment : Test can share interactive demos that decision makers can try themselves

## How AI Apps works

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3893a1b8c5657d68250e60ab49b2a2f9981ad920-3024x1890.webp)

Vellum automatically analyzes your workflow and generates an AI App UI for your deployed Workflow. In this UI, &nbsp;you'll see all &nbsp;the required input fields that match your Workflow’s parameters, text inputs, numerical values, file uploads, and other data types..

When you hit Run , Vellum calls the same APIs your production environment does, and the results are streamed in realtime. The result is an interactive and simple to use AI app, that was built in a fraction of second.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4987a5133d1ed0b4734fc1b03230db0c03a873c9-3008x1666.webp)

## Key capabilities

Intuitive input interface: Input forms are auto-generated to match your Workflow, including text fields, numbers, file uploads, and more. Real-time execution: Run Workflows with production-level reliability and watch outputs stream back as they’re generated. Interactive testing flow: Edit inputs and re-run executions as many times as needed in the same session. Seamless access points: Open an AI App from the Share Workflow modal or directly from your Deployments overview.

### Feature overview

tag) --> Capabilities What It Does Why It Helps Auto-generated App Interface Vellum auto-generates clean fields for text, numbers, file uploads, and more. Anyone can test a Workflow without writing code or setting up API calls. Real-Time Execution Runs Workflows with production reliability and streams output as it’s generated. Validates behavior instantly and mirrors what happens in production. Interactive Testing Flow Edit inputs and re-run executions within the same session. Speeds up iteration cycles and makes debugging frictionless. Seamless Access Points Launch AI Apps from the Share Workflow modal or the Deployments overview page. Quick entry for both developers and non-technical teammates. Production-Grade Accuracy Executes against the same Vellum APIs that power live integrations. Ensures results match real-world execution, not mock data. Collaboration Ready Share the AI App UI link with teammates and stakeholders. Makes testing and demos accessible across your organization.

## How to access AI Apps

There are two ways to open an AI App in Vellum:

1. Share Workflow Button – From any deployed Workflow, click the Share button to reveal both the AI App link and traditional read-only options.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b29fa053153ab57607fc3158b238511149eec65a-1086x1030.webp)

2. Deployments Overview – Visit the Deployments page and open the AI App directly from the Workflow card.

#### Now, everyone can build their AI apps

We built AI Apps to help everyone on your team to become AI native, faster. The powerful Workflows you create in Vellum shouldn’t be gated by engineering’s bandwidth, they should be accessible and usable across the whole org. This is a step forward to help the organizations using Vellum to become truly AI-native.

Developers can rapidly test logic changes, fine-tune prompts, and debug without juggling API calls or external apps Product, Ops &amp; Business teams can validate automations against real data, ensuring processes run smoothly before they go live. Leaders &amp; Stakeholders can interact with Workflows firsthand, gaining clarity and confidence in how AI is shaping business operations. Internal teams can use AI Apps as powerful AI tools for day-to-day work, without needing a custom UI or API integration.

AI Apps are just the beginning of making Workflows accessible across every corner of your organization. We’re excited to keep building on this foundation, and can’t wait to see how your teams put AI Apps to work.

Read the full documentation here: Agent App Docs

## FAQs

1. What are AI Apps in Vellum?

AI Apps are interactive, no-code interfaces automatically generated for any deployed Workflow in Vellum. They let you run, test, and share Workflows directly in the platform without needing custom code or external tools.

2. How do AI Apps differ from using the API directly?

While the API gives developers full control for integrations, AI Apps provide a ready-made interface for testing, demos, and everyday internal use. Both hit the same production-grade APIs under the hood, so results are identical.

3. Who can use AI Apps inside my organization?

You can enable anyone in your org with access to your Workflow’s App with a sharable link. This makes Workflow testing and usage collaborative instead of developer-only.

4. Can AI Apps be shared outside of my organization?

Yes, you can share any AI App through the AI App link. Fetch the link by pressing the “Share” button in Workflows or the AI App link present in the deployments window.

5. What types of inputs are supported in AI Apps?

AI Apps support any input available in your workflow. It auto-generates input fields based on your Workflow to make it easy to populate input fields and replicate production conditions when testing.

6. How do AI Apps support internal tooling?

Teams can internally use AI Apps as powerful AI agents or automations for all sorts of tasks like document analysis, reporting, content generation, etc. This avoids the need to build a custom UI or integrate with another system just to use the Workflow.

7. Do AI Apps cost extra to use?

No. Running a Workflow through an AI App consumes the same credits/resources as running it through the API. There are no additional fees for using the AI App interface itself.

8. How do I get started with AI Apps today?

Simply deploy a Workflow in Vellum. From the Deployments page or the Share button in Workflows, use the link to open the AI App. You’ll instantly see a ready-to-use interface.

## Extra Resources

Agent Nodes for Built-in Tool Calling in Workflows → Partnering with Composio to Help You Build Better AI Agents → How to continuously improve your AI Assistant using Vellum → How agentic capabilities can be deployed in production today → Understanding agentic behavior in production →

## Ready to launch AI Apps in Vellum?

Start free today and see how AI Apps make your deployed Workflows instantly usable across your organization—with no code and real-time execution.

Get started with Vellum free →
