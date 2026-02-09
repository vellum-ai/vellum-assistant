---
title: "Vellum Product Update | May & June"
slug: "product-update-may-june"
excerpt: "AI-powered features and easier ways to customize and build together, across both the SDK and visual builder."
metaDescription: "AI-powered features and easier ways to customize and build together, across both the SDK and visual builder."
metaTitle: "Vellum Product Update | May & June"
publishedAt: "2025-07-01T00:00:00.000Z"
readTime: "6 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1dcb3c94f2741337d43cf4a6a4537961eb83a383-716x493.png"
---

Over the past two months, we’ve been focused on two core themes: launching AI-powered features and making it easier for teams to customize and collaborate across the SDK and visual builder.

You’ll see that in everything from running Custom Nodes directly in the UI, to new AI tools that help you write better prompts and document your work faster. We’ve also made it easier to bring in Docker images, standardize deployments, and fine-tune how your team builds and ships.

Here are the latest updates:

## Run Custom Code Nodes in the UI

We’re building Vellum to give product engineering teams the building blocks they need to get started fast, with the flexibility to customize every part of the workflow together.

That’s why so far we’ve enabled Code Execution Nodes in the UI, and Custom Nodes in the SDK enabling you to execute any logic you need.

But until now, Custom Nodes created in the SDK couldn’t easily be used in the visual builder.

Today, you can run vellum workflows push [module] on any Workflow that features a Custom Node, and that Node will be runnable in the UI!

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b45d0688aaf802a44636c2897acb85808e9791ed-1289x280.png)

The UI has all support for this Workflow Node like ports, adornments, trigger behavior, expressive attributes and more.

## Custom Docker Images &amp; Nodes in the Visual Builder

As an extension to the above update, we’ve also enabled a way to bring SDK-defined Docker images into the visual builder (UI).

Docker images defined through the SDK are useful for pulling in your full repo or handling bespoke binaries that don’t play well with the supported SDK language. And now, you can build and push your image, and your Custom Nodes will automatically show up in the UI side panel, ready for anyone on your team to drop into a workflow.

To make it work, just include a vellum_custom_nodes folder in your Docker image containing your Node.

Additionally you can now run Workflows within a Custom Docker Image.

### Run Workflows within a Custom Docker Image

Workflows that are SDK enabled can now be run in a Docker Image of your choice! By default, all Workflows run in our base image, vellumai/python-workflow-runtime:latest . You can now extend that base image to define a new Docker image, push it up to Vellum, then associate it with your Workflow:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8114eecba79d5b2395fdaca73e3517fca12e3d47-846x450.png)

## AI-powered Features

We’re excited to launch our first AI powered features in Vellum. And what better way to start than by helping you write higher performing prompts and help you organize your work better!

### Prompt Improver (Beta)

Now, you can use this feature to generate improved versions of your prompt directly from the Prompt Sandbox. This feature uses Anthropic under the hood and generates new prompts based on best practices . This feature is in beta and we would love to hear more feedback on how we can improve it!

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6b95c6e21797e2bb4921d4902f94c82e951151d9-1592x862.png)

### AI-generated Workflow Descriptions

When editing a Workflow’s details, Vellum now auto-generates a draft description for any Workflow without one. Powered by AI, it looks at your Workflow’s structure, nodes, and metadata to give you a solid starting point, making it easier to document and helping new teammates get up to speed faster.

You can enable or disable both of these features from your Organization Settings under the “AI Features” section.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/59eed14b69167d7edd6eaffac404f78822551c41-1450x322.png)

## Global Default Release Tags

Previously, Vellum defaulted to the LATEST Release Tag when creating a Prompt or Workflow Deployment Node. Today, you can set your own global default Release Tag, like “production” or “staging”, so every new Deployment Node starts with the setup that matches your team's workflow.

Find it under Organization Settings &gt; Advanced Settings &gt; Default Tag Settings .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9bd84639067e36ba32890f17ecc13a6fb16aea28-1352x376.png)

## Configurable Data Retention Policies

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a73059b5f301e05d5ae2691a198a18d7170e840e-1414x298.png)

Enterprise customers can now configure data retention policies for their organization. This new feature allows you to:

Set whether monitoring data is retained indefinitely (default) or for a specific time period Choose from predefined retention periods (30, 60, 90, or 365 days)

## Expression Inputs on Final Output Nodes

Previously, Final Output Nodes only allowed you to reference values like Node Outputs, Inputs, etc. Now, you can do more with these values and write an Expression to define the Final Output you want ( Quick demo ).

For example, you can use the accessor operator to reference an attribute in a json output from a Prompt Node by using this expression input: Output Value = Prompt[JSON].foo

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/bf42670a8ce5d4e4a5b0afb10033b09820fde9bb-1838x802.png)

## Evaluation Updates

### Edit Test Cases in a Resizable Side Drawer

We’ve improved the Evaluation Report table to make editing Test Cases easier and more intuitive.

Now, clicking an editable cell opens a side drawer where you can update variable values, switch between tabs, and navigate between rows. The new layout is cleaner, more spacious, and supports keyboard shortcuts for faster editing—perfect for working with complex Test Cases.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/bd0e43f29702bca890ac1dd955ac3c481a2c2b25-2934x1804.png)

### Duplicate Test Cases in Evaluation Reports

You can now duplicate Test Cases directly from the Evaluation Report UI, making it much faster to create slight variations without starting from scratch.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6e68dd708e37ef7ec3f303697cbb22bf0fd923f9-2798x1332.png)

### Bulk Apply Value to Test Cases

You can now efficiently apply a cell’s value to multiple Test Cases at once. A new icon button appears in each Test Case cell that, when clicked, opens a confirmation modal asking whether you want to apply the current cell’s value to all or selected test cases.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8c90eeedff26ec746dccc5fa4a01f871efc25885-2944x1594.png)

## New Models

We’ve added support for the following models:

Vertex AI Claude 4 Models

- AWS Bedrock Claude 4 Models
- All Claude 4 models
- All Gemini 2.5 models
- OpenAI GPT 4o Search Preview
- GPT 4o Mini Search Preview
- Codex Mini (Latest)
- Support for OpenAI’s new Responses API endpoint
- GPT-4o Audio Preview
- Azure DeepSeek v3 via Azure AI Foundry
- GPT 4.1 and 4.5 Model via Azure OpenAI
- Microsoft OmniParser V2
## Other updates

Condensed Node View : You can now enable Condensed Node View from the Navigation Settings to streamline your workflow interface. This feature displays all Nodes in a more compact format, significantly reducing visual clutter and making it easier to navigate complex workflows with many Nodes ( Quick Demo )

Redesigned Deployment Flow : We’ve redesigned the Deployment Flow for Prompt and Workflow Sandboxes with a cleaner layout, streamlined forms, and an improved Releases tab to make managing deployments and release tags more intuitive. You can also now add descriptions to your Prompt and Workflow deploymnts.

Global Search Navigation : You can now navigate Vellum using global search and keyboard shortcuts. Open global search by clicking the search bar or using cmd-K, then press / to display available navigation options and quickly jump to different sections of the platform without using your mouse.

Smart Labels for Node Input Variables : Previously, Node input labels remained static regardless of their content. Now, input labels automatically update to reflect the value or expression they contain, making your Workflows more intuitive and self-documenting. ( Quick demo )

OpenAI Base64 PDF Files : We now support OpenAI Models newly added capability to use Base64 documents within API requests.

Structured Outputs and Json Mode Support for x AI Models : We have added the ability to have Grok models that are hosted on xAI to return responses in JSON format via an agnostic JSON Mode, or a formatted Structured Output.

Gemini Vertex AI Models Are Now Region Specific : &nbsp;Gemini Vertex AI Models are now available as region-specific instances, giving you the flexibility to enable models in multiple regions and build more reliable workflows with fallback support.
