---
title: "Vellum Product Update | July 2024"
slug: "vellum-product-update-july-2024"
excerpt: "Learn about the latest features and improvements shipped by the Vellum team in July."
metaDescription: "Learn about the latest features and improvements shipped by the Vellum team in July."
metaTitle: "Vellum Product Update | July 2024"
publishedAt: "2024-08-06T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build AI systems that you can trust."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/11b95ab134070d42bb198e3be77e6b9233851bc7-1107x762.png"
---

August has arrived, and with it comes a whole host of improvements to Vellum!

We've added some great new features like Prompt Variable Chips and Prompt Node Usage in Workflows. Plus, we've packed in an assortment of improvements to Workflows, Evaluations, and Deployment help with your AI development flow.

Let's take a closer look at our fav features introduced this month.

Prompt Variable Chips

Previously, you had to use {{ myVariable }} syntax to reference variables in Prompts. While the doubly-curly syntax is great for more complex Jinja templating, it can be overkill for simple variable substitution. It's harder to read, conflicts with JSON syntax, and requires manual updates when renaming variables.

To simplify this, we've introduced Variable Chips .

These are small, clickable chips you can add by typing ** {{** or / . Renaming a variable updates all references automatically.

Variable Chips work in the new "Rich Text" block type. New Prompt blocks default to Rich Text, but you can convert between existing Jinja blocks and the new Rich Text block by selecting the block type dropdown in the toolbar.

Check the demo here .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a9819257ab67b3382b3e2688768b5bd86ebb7cf7-1534x1614.png)

Prompt Node Usage in Workflows

Previously, when running Prompts in the Workflow Sandbox, you couldn't see token counts and other usage metrics in the Prompt Node results.

Now, token counts are shown alongside a Prompt Node’s results within Workflow Sandboxes. &nbsp;This setting is now on by default, but can be toggled off in the Workflow Builder Settings.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8d137dba5357bc76ff6abe4b1fd1d52b73b1abc3-1004x914.png)

You can also now return usage data when invoking a Workflow Deployment via API, by passing in True to the expand_meta.usage parameter on either Execute Workflow endpoints.

‍

Metadata Filtering in Search Nodes

For a while now, you’ve been able to add structured JSON metadata to Documents and filter against it when making API calls to search a Document index (see here for more info). However, this wasn't possible via Search Nodes within the Workflow UI. You had to use a Code Node or API Node to call Vellum’s Search API manually.

Now, we’re happy to share that the UI is at parity with the API. You’ll be able to construct arbitrarily complex boolean logic using the new Metadata Filters section of the Search Node’s Advanced settings.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/72ed90e1b806d56b437436506b1ab63e40160620-1063x896.png)

Other Workflows Updates

## Enable/Disable All Workflow Node Mocks

Mocking Prompt Nodes helps to save token usage and iteration time when developing the later stages of your Workflow. However, once you’re happy with your Workflow, it’s often useful to run the Workflow end-to-end to make sure it all comes together.

Previously you had to enable/disable each mock individually, but this month we added support to enable/disable all mocks within a Workflow at once.

This feature simplifies the process of testing and debugging, allowing you to quickly switch between real and mocked data without issue.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/e584ac4f3f05b3b27db4c791b76aa96fd0d3f930-1048x770.png)

## Constant Values in Workflow Node Inputs

It’s often the case that you might want to specify a constant value as a Workflow Node Input, either as the input’s primary value or as its fallback value. This required cumbersome workarounds before (i.e. referencing Input Variables our the outputs of Templating Nodes).

Now, you can inline constant values directly within a Workflow Node input!

Read how to do it here .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ade7286eb81c1b023e79175ad719e0d233c78e26-800x390.png)

‍

Other Evaluations Updates

## Test Suite Test Case External IDs

Previously, there was no straightforward way to sync Test Cases with external systems. Now, you can optionally assign an external ID to each Test Case upon uploading them to Vellum to make it easier to upsert changes later, keying off of that ID.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/fe66309b7209065df8267d42bd3208832b8005e5-1804x874.png)

## Support for Bulk Upserting Test Suite Test Cases via API

For a while now we’ve had an API for creating, replacing, and deleting Test Cases in a Test Suite in bulk. We now support a fourth operation in this API – upsert. With upsert, you can provide an external_id and a Test Case payload. If there is already a Test Case with that external_id , it’ll be replaced. Otherwise, it’ll be created.

This new operation is available in our SDKs starting v0.6.12.

## Test Case CSV Upload in Evaluation Reports

Previously, if you wanted to upload Test Cases, you had to first navigate to the Test Suite itself and upload from there - making this process a lot more complex than it should be.

You can now upload Test Cases to a Test Suite directly from the Evaluations tab of a Prompt or Workflow. Just click the “Upload Test Cases” button in the header of any Evaluations table.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f11cf9e602b5941dcb4ecf6345ab3ab3eed58a43-2422x1068.png)

## New Layout for Sandbox Evaluations

The previous layout for Evaluations should all Test Suites at once. This made the page cluttered, difficult to navigate, and sometimes laggy. We've updated the page layout to display one Test Suite at a time with a searchable select input.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4e531866d91eaf6153ca4180527b607052ca36cb-1444x304.png)

‍

Other Prompts Updates

## Auto-Conversion to Variable Chips on Paste

You can now copy/paste variables across Prompt Blocks of different types.

If you copy text with a {{ my_var }} variable from a Jinja block and paste it into a Rich Text block, it will automatically turn into a variable chip.

## Improvements to Prompt Chat History Variables

Previously, Prompts with dynamic Chat History needed an input variable specifically named $chat_history . This was understandably confusing for new customers.

Now, you can name Chat History input variables anything you want and even rename them later. We've also centralized input variable definitions, so you can create a String or Chat History variable using the "Add" button in the "Input Variables" section of the Prompt Editor.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9df4f1c81ed7dfb99a7beb80b68cdc31f2a632ef-1464x246.png)

‍

Other Deployments Updates

## Expandable Meta Params in Retrieve Provider Payload Endpoint

For a while now, we've had an API to compile a Prompt and get the exact payload Vellum sends to a model provider. Now, there's a new parameter called expand_meta . With this parameter, you can get extra metadata about the compiled prompt payload. Check our API docs to see which fields are expandable.

## New “Add Document to Document Index” API

We’ve introduced a new API for adding previously uploaded Documents to a Document Index. This API is useful when you have a Document that had previously been added to one Document Index and you want to add it to another without having to re-upload its contents altogether.

It’s available in our SDKs beginning version 0.6.10. You can find docs for this new API here .

## Prompt Deployment Executions Table Improvements

We've improved the Prompt Deployment Executions table by making it easier to quickly edit the “Desired Output” and “Quality” columns. This is helpful if you have a team of in-house data labelers that are providing feedback on the quality of your AI systems’ outputs.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b15d14f61041f630a0bb766bf8ae458cbc760b1b-2422x1804.png)

‍

New Models

## Google Vertex AI Support

We now support Google Vertex AI models. Previously you could only use Google AI Studio for using Google’s models. You can add them to your workspace from the models page . ‍

## Llama 3.1 on Groq

Meta’s newest Llama 3.1 models are now available in Vellum through our Groq integration!

## GPT-4o Mini

OpenAI’s newest GPT-4o Mini models gpt-4o-mini &amp; gpt-4o-mini-2024-07-18 are now available in Vellum and have been added to all workspaces!

‍

Quality of Life Improvements

## Index Page Sorting

We've added a “Sort by” dropdown to sort folders and entities by created date, modified date, and label. We hope this gives you more control over how you organize and view your data.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3c6c6b6e7e3b69d7be0832ff59eb7968e00e5c42-1268x674.png)

## Deployed Prompt Variant Display

When on the Prompt Deployment Overview page, you can now see the name of the Prompt Variant that’s been deployed. This is useful if your Prompt Sandbox has multiple Prompt Variants that you were comparing against one another and you’re not sure which one is currently deployed.

## Copyable Text to Clipboard

We’ve introduced the ability to copy Prompt Variant IDs, Document Indexes, Models, Workflow Deployment Names and IDs, Document Keys, and Prompt Deployment Names and IDs to clipboard.

This feature comes with an enhanced UI with intuitive indicators and tooltips for copyable fields.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/08973b680c9a2e411215172fe583d8ac43bb893b-2256x1272.png)

## Index Page List View

You can now toggle how entities are displayed between two modes – Card (the default) and List view. List view can be helpful if you have many entities and want to see more of them at once.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9218e802ff7eaf22c8ef37512cd2a1804d333049-1958x1574.png)

## Collapsible Index Page Sections

You can now collapse sections index pages for Prompts, Documents, Test Suites, and Workflows. Simply click the heading of any section to toggle the visibility of all folders and items within that section.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/76ceb6d77aa15f3684413d61267eb136b7a80eef-1958x1292.png)

# Looking ahead

We hope these updates enhance your experience and productivity. As always, we look forward to your feedback and are excited to see what you'll build next!

August will bring so many exciting features and we can’t wait to share those with you.

## Table of Contents

Prompt Variable Chips Prompt Node Usage in Workflows Metadata Filtering in Search Nodes Other Workflows Updates Other Evaluations Updates Other Prompts Updates Other Deployments Updates Models Quality of Life Improvements
