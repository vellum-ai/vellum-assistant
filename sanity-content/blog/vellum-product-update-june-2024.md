---
title: "Vellum Product Update | June 2024"
slug: "vellum-product-update-june-2024"
excerpt: "Learn more about the latest updates at Vellum: Map Nodes, Inline Subworkflows, API updates and more"
metaDescription: "Learn more about the latest updates at Vellum: Map Nodes, Inline Subworkflows, API updates and more"
metaTitle: "Vellum Product Update | June 2024"
publishedAt: "2024-07-09T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build a production-grade AI product today"
authors: ["Noa Flaherty  "]
category: "Product Updates"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/11b95ab134070d42bb198e3be77e6b9233851bc7-1107x762.png"
---

Welcome to another exciting Vellum Product Update!

June brought some eagerly-awaited features to Vellum that’ll help you build even more powerful AI systems!

Let’s start with one of the more exciting updates: Map Nodes.

‍

Map Nodes

Up until now, iterating over an array of dynamic length and running a Subworkflow for each item required custom scripting or complex configurations and serial execution. You were required to manually set up a loop by connecting Nodes in a tedious layout that looked something like this:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a6e25b3f5bd903dcd77f5ecfeae9a3d3de7d2b13-1400x886.png)

Now, you can use Map Nodes to iterate over an array and run a Subworkflow for each item in parallel.

Map Nodes work in the same way that array map functions do in many common programming languages (like Javascript’s Array.prototype.map ). Map Nodes take a JSON array as an input and iterate over it, running a Subworkflow for each item. It supports up to 12 concurrent iterations, making it highly efficient for batch processing tasks.

Watch this demo to understand how to set it up, so you can switch from the tedious layout above to the more elegant workflow shown here:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/dd936b7f933c988c8967d81520a61b9af57205ce-3124x1744.png)

‍

Inline Subworkflow Nodes

Subworkflows in Vellum are a great way to create reusable units of node logic and compose/organize more sophisticated Workflows.

Previously, you had to create and deploy these units in a separate Workflow before using them as a child of another.

Now, you can create and group modular units of nodes directly within an existing Workflow using Inline Subworkflow Nodes . This feature supports a similar user experience as the parent Workflow, ensuring consistency and ease of use.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ebe1cc8a80f9dba9e3647355d1922393fe06ce59-2954x1784.png)

This update is very important when developing your AI apps as it allows you to encapsulate complex logic in subunits without losing the context of the main Workflow!

‍

Workflow Notes and Comments

Before, documenting your Workflow logic wasn’t possible, and collaborating required communicating outside of Vellum.

Not anymore! Now, you have two options to document your work: Notes and Comments .

Use Notes with customizable colors and font sizes to add high-level documentation about your workflow. Use Comments – a property of each Node – to document that specific Node’s purpose.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/fd0e66d1032c40c2a98ec3f66affae5d6e308504-2343x1320.png)

By adding notes and comments in your Workflows, you can provide context, instructions, or explanations, making it easier for you and your team to understand and manage complex AI systems.

‍

Other Workflows Updates

## Undo and Redo for Workflow Sandboxes

Making changes within Workflow Sandboxes was a one-way street, with no easy way to undo or redo actions. You can now use undo and redo functionality within Workflow Sandboxes using keyboard shortcuts or the UI buttons.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d12f7b52f3904cc5869aea4812fdfde716158d27-1112x1072.gif)

## Support for Multiple Outputs in Workflow Metrics

Using Vellum Workflows to create LLM-based evaluators (i.e. have one AI grade another AI) is super powerful, but to date, you’ve only been able to use Workflows that produce a single score output.

We now have official support for Workflow Evaluators that produce multiple outputs!

If your Workflow has at least one Final Output Node called score with a type NUMBER , you can add more Final Output Nodes with any names and types you want.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/153464620ef146a277cd9114416d95c3187f6bde-2834x788.png)

‍

New APIs

## API for Updating a Test Suite’s Test Cases in Bulk

For a while now you’ve been able to programmatically upsert and delete Test Cases in a Test suite individually. While useful, this was problematic if you want to perform the same actions on multiple test cases at once.

To solve this, we’ve added an API to create, replace, and delete Test Cases in bulk.

Check out the new Bulk Test Case Operations API in our docs here .

Note: this API is available in our SDKs beginning version 0.6.4.

## APIs for Programmatically Deploying Prompts/Workflows

Thanks to the desires of a few very forward-thinking customers, we now have APIs to support programmatically deploying prompts and workflows.

These APIs can be used as the basis for CI/CD pipelines for Vellum-managed entities.

We’re super bullish on integrating Vellum with existing release management systems (think, Github Actions) and you can expect to see more from us here, soon!

To deploy a Prompt, you’ll need the IDs of the Prompt Sandbox and the Prompt Variant shown here:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/484e68be168f2218e5f45051c83247fa5d58bb37-3454x2158.png)

And can then hit the Deploy Prompt endpoint found here .

Similarly, to deploy a Workflow, you’ll need the IDs of the Workflow Sandbox and the Workflow shown here:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/484e68be168f2218e5f45051c83247fa5d58bb37-3454x2158.png)

And can then hit the Deploy Workflow endpoint found here .

Note: these APIs are available in our SDKs beginning version 0.6.3.

## APIs for Programmatically Moving Release Tags

We’re also excited to also announce APIs for programmatically moving Release Tags .

With these APIs, you can create a CI/CD pipeline that automatically moves a Release Tag for one environment from one version of a Prompt/Workflow to another. For example, you might run certain tests or QA processes before promoting STAGING to PRODUCTION .

To move a Prompt Deployment Release Tag, check out the API docs here .

To move a Workflow Deployment Release Tag, see the API docs here .

Note: these APIs are available in our SDKs beginning version 0.6.3.

‍

Quality of Life Improvements

## Breadcrumb Context Menus

Navigating and managing folder structures was challenging, so we made some changes to improve navigation:

You’ll now see breadcrumbs that show the folder path when visiting the details of an entity in Vellum. This helps you see the file structure and easily navigate up to a parent folder. You can rename a parent folder by right-clicking on its breadcrumb without navigating to its parent. You can now access all of an entity’s “More Menu” options by right-clicking its card in the grid view.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9d402d39a6d759f6e0c4bf59a5ffd8af18b08fb7-910x434.png)

## Override Vellum Provided API Keys

You can now provide your own API keys for models that Vellum provides API keys for such as Fireworks hosted models. To do so, click the 3 dot menu on a Model card and click the “Set API Key” option.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/354fb535336efdb8f5efd942cb1d613582d2129b-850x820.png)

## Image Support in Claude 3 and Gemini Models

Previously, the Claude 3 and Gemini models were limited to text-only processing.

Vellum now also supports multi-modality for Claude 3 and Gemini models, allowing parsing images and returning text.

For more on how to work with images in Vellum, see our help docs here .

## Claude 3.5 Sonnet Support

We now support the new Claude 3.5 Sonnet model. It has already been automatically added to all workspaces.

We also support the model hosted through AWS Bedrock. You can add it to your workspace from the models page .

# Looking ahead

That's a wrap for June — with many updates for workflows and CI/CD pipelines. We have bunch of improvements for Workflows and Evaluations planned for July as well.

Also, we’re super bullish on integrating Vellum with existing release management systems (think, Github Actions) and you can expect to see more from us here, soon!

Until next month!

‍

‍

## Table of Contents

Map Nodes Inline Subworkflow Nodes Workflow Notes and Comments Other Workflow Updates New APIs Quality of Life Improvements
