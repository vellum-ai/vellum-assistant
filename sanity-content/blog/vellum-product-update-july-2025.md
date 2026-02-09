---
title: "Vellum Product Update | July"
slug: "vellum-product-update-july-2025"
excerpt: "Upgraded Environments, Workflow, and Prompt Builder plus a new Agent Node for faster and easier building on Vellum."
metaDescription: "Upgraded Environments, Workflow, and Prompt Builder plus a new Agent Node for faster and easier building on Vellum."
metaTitle: "Vellum Product Update | July"
publishedAt: "2025-08-12T00:00:00.000Z"
readTime: "5 min"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/befd7c2e2df56a9420e4906cdcef58e5effa6877-1280x800.heif"
---

August is here, and with it comes a fresh batch of updates designed to make your AI development experience smoother, more flexible, and more powerful than ever.

This month, we’re excited to introduce first-class support for Environments, a new Tool Calling Node for Workflows, a redesigned Prompt Editor, and a host of quality-of-life improvements across the platform.

Let’s dive into the details!

## Environments: Streamlined Deployment Stages

Managing different deployment stages used to require manual workarounds and made it tough to keep development, staging, and production cleanly separated.

Now, Vellum offers dedicated Environments for Development, Staging, and Production. Each environment has its own resources, API keys, release history, document indexes, and monitoring filters.

You can also define Environment Variables (including secrets) with values specific to each environment, making it easy to maintain different configurations without changing your core logic.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/2693ad582b22cb8cc94aff8139e7cd6d59863f50-1908x930.png)

Promoting a tested release from one environment to another is now a single click in the UI, and you can deploy Prompts or Workflows to multiple environments at once.

This structured approach helps you avoid configuration errors and maintain best practices as your team scales.

## Agent Node: Built-In Tool Calling

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9f7bdaf58eaa89d94a5409878400a5056986bcb0-1188x680.png)

Function calling requires defining schemas, handling inputs and outputs, and managing repeated calls until a valid end state is reached. This pattern is often rebuilt across teams, leading to duplicated work, slower iteration, and higher maintenance costs. To address this, we now offer an out-of-the-box option that standardizes tool use while still allowing full manual control when needed.

Introducing the Agent Node!

This Node makes this easy to add tools that a model can invoke to accomplish a given action. &nbsp;To add tools you can use three options:

Writing custom code Reusing Subworkflows, and Subworkflow Deployments Integrating with your Composio tools

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1ecdccff4adefbaa74962aba3c90f1f6ce28134b-922x602.png)

Types of tools you can add in your Agent Node.

By GA’ing the Agent Node we’ve handled the common orchestration logic around it in a first-class way. Now, your engineers no longer have to rebuild the same patterns, and non-technical teams can reuse pre-built tools out of the box.

You can read more about it &nbsp; here , or join our product office hours this week on Wednesday, Aug 13th, where we’ll show you exactly how you can use it in your workflows!

## Workflows

### API Node Timeout Configuration

Long-running or unresponsive API calls could hang your workflow indefinitely.

Now, you can set a timeout on API Nodes to keep workflows responsive and handle slow or failing services gracefully. This is especially useful when working with third-party APIs.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/de9a9be51892fd2dde6c701ad164d71af53158a4-453x677.png)

### Node Results Side Panel

Debugging complex workflows used to mean clicking through each node one by one.

With the new Node Results Side Panel , you get tabbed navigation for Inputs/Outputs and improved formatting, making it much easier to compare and debug your workflow’s execution path.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/0b27891a405ad8f3ec217a0e50943352db56fc5f-1147x643.png)

### Workflow-Level Packages

Previously, you had to define package dependencies separately for each Code Node.

Now, you can set package dependencies at the Workflow level, ensuring consistent versions across all code nodes and reducing redundancy. You can now define package dependencies at the Workflow level through the Workflow Settings modal.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f7c479cedb596812e8926db4ebc51fa2b654379c-2863x1489.png)

### Private Package Repositories

Using private packages in workflows required clunky workarounds.

Now, you can use private repositories (Python, AWS CodeArtifact) in Code Execution Nodes and Code Metrics, making it easy to integrate your organization’s proprietary libraries.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a388eef997b746dedfc6daa075d35a6446868fe0-1340x624.png)

### Expression Input/Output Type Improvements

It was tricky to know what data types were flowing between nodes.

The improved expression input dropdown now shows explicit Node output types, structured output warnings, and is fully keyboard accessible:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d3f7ecd5831e08d1d41cd9a9204a52a7f07f21ea-1210x1180.png)

### New Workflow Execution API

We are now introducing a new API endpoint for retrieving specific Workflow Execution details. This new endpoint allows you to fetch detailed information about any specific Workflow Execution using its execution ID.

The new endpoint is available at: ‍ GET /v1/workflow-executions/{execution_id}/detail

And provides,

This API returns full details of a workflow execution, covering its status and metadata, inputs and outputs, per-node execution and timing, any errors, and cost and usage data. Try it out here .

## Prompts

### Prompt Editor Layout Update

The old two-column Prompt Editor could feel cramped.

The new three-column layout (Configuration &amp; Variables, Prompt Editor, Output) gives you more space and a more intuitive left-to-right workflow, making prompt engineering easier than ever.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/cfe62beca802f450a35a206b398fc930222037fa-3440x1772.png)

### Prompt Node Unification

Creating different types of Prompt Nodes used to involve different workflows.

Now, there’s a unified creation flow for all Prompt Node types (From Scratch, Import, Link to Deployment) with improved UI for linked prompt details, making it easier to reuse and manage prompts.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a7fc720a254119f76d4d12ef6700bd419aff1925-2928x1620.png)

### Reasoning Outputs in Prompt Sandboxes and Nodes

Previously, understanding the model’s reasoning process was a black box.

Now, you can view the model’s reasoning/thinking process in both Prompt Sandboxes and Workflow Nodes (requires API version 2025-07-30). This helps you debug and improve prompt performance with real insight into how the model thinks.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3ed48d38842969e02631593e06b0756f6aeef4fe-3456x1822.png)

### Model Picker Improvements

Finding the right model meant scrolling through long lists.

The improved Model Picker now has a Features filter, better sorting, and enhanced model cards, making it easy to find models with the capabilities you need.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5e1658f5923f0860b274977162f9bec8135a3eca-741x504.png)

## New Model Support

We’ve added support for:

BaseTen models (Deepseek R1 0528, Deepseek V3 0324, Llama 4 Maverick, Llama 4 Scout) xAI’s Grok 4 Google Vertex AI’s gemini-embedding-001

More options to help you find the right balance of performance, cost, and features.

## Quality of Life Improvements

### Editable Document Keywords

Updating document keywords used to require re-uploading.

Now, you can edit keywords directly in the UI —triggering automatic re-indexing and making it easier to refine your document retrieval system, especially for RAG applications.

### API Versioning

API changes could impact existing integrations.

With the new API versioning system , you can specify the Vellum API version via header ( X-API-VERSION ), and select the version when developing/testing workflows. This keeps your integrations stable while letting you adopt new features when you’re ready.

## See You in September!

That’s a wrap for August! We hope these updates help you build faster, deploy safer, and get more out of Vellum. As always, we’d love your feedback—let us know what you think and what you’d like to see next!
