---
title: "Vellum Product Update | August "
slug: "vellum-product-update-august-2024"
excerpt: "More control with workflow replays, cost and latency tracking, and new Workflow Editor UI"
metaDescription: "More control with workflow replays, cost and latency tracking, and new Workflow Editor UI"
metaTitle: "Vellum Product Update | August "
publishedAt: "2024-09-10T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build production-grade AI application that you can trust"
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/346d65ef4bed5b65d4342e1eb69a1220a7d22c40-716x493.png"
---

‍

‍

September’s here, and it’s that time of year when everything feels like a fresh start.

As we enter the new season, we’ve got some exciting updates and new features that the team worked on last month!

We've released more than 20 features and improvements! Starting with easier workflow replays with the new Scrubber tool to prompt caching for faster, cheaper runs, we've focused on giving you more control and saving you time. We’ve also added cost tracking for prompts in the sandbox, and there’s a new Workflow Editor beta to test out.

Let’s get into the details.

‍

Replay Workflow Executions

Analyzing complex workflows used to be difficult — you had to re-run the whole workflow and carefully track the outputs at each step. While some steps finished quickly, others took longer, and loops generated multiple outputs, making it harder to track everything.

Now, you can use the Scrubber to replay and navigate through your Workflow Sandbox while prototyping or use it on the Deployment Execution Details page to replay a specific execution in production.

The more loops and retry logic in your Workflow — the more you’ll need this feature. To use it just set the replay speed and click play or scroll manually through the scrubber to analyze specific execution points

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/39abb592ce5dd06077e91df50821d7e35e692339-1728x958.gif)

‍

Prompt Caching Support

If you find yourself reusing parts of your prompt for subsequent calls — prompt caching will make it 1) easier 2) cheaper 3) faster to run those workflows. It works great for tasks like longer chat-based conversations or coding questions where you need to keep your context consistent.

Today, we support this feature natively in the Prompt Editor for all supported models by Anthropic. To use it, just toggle the “Cache” option in the Prompt Block for supported models like Claude 3.5 Sonnet and Haiku. Once enabled, it will automatically cache frequently used portions of your Prompt for up to 5 minutes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/835e434326b8f26b9194c25a5c3229de3be37096-1406x720.png)

‍

New Workflow Editor Beta Release

As models introduced new parameters and architectures evolved into more complex structures, we recognized the need to reorganize certain customization elements to create a smoother, more user-friendly UI experience.

Our efforts translate to the new Workflow Editor, which is now available as an opt-in beta release.

The next time you open the Workflow Editor, you’ll see an announcement with the option to try out the new Editor experience 👇🏻

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a193e8a1d7e2edba0de61ac33a7bf4d801232721-2724x1812.png)

Once you enable the new UI you'll notice many improvements, like the:

New side-nav bar makes it easier to access and edit core prompt settings (e.g. input, output variables and types) without disrupting your workflow. A cleaner node-level UI making it easier to spot features and interact with them easily.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/c17a318b1314292a169fb5da53db614d6dc4480f-2724x1812.png)

We’re revamping this UI to make it quicker to navigate, easier to edit, and faster overall. More updates are coming to this view — and we’d love to get your feedback about the new experience, so please let us know what you think!

‍

Prompt Node Linked Deployments

Previously, if you updated a prompt, you’d have to manually update it in every Workflow that it’s used in.

The setup now has a new Link to Deployment option. This is a Prompt Node that directly connects to a specific version of your Prompt within a Workflow using a Release Tag.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d3a5c1d69d23d17f9f66c8f26d0d891f3fc29cc8-1860x946.png)

This means your Workflows, whether in Sandbox or live, will always pick up any changes to the Prompt without you needing to update anything, as long as you're pointing to the LATEST .

If you want to stick to a particular version, you can use a custom Release Tag to keep the Prompt Node locked to that version.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/03563e0d39c24b8f2b7f3208ab745b8e67c6b2cf-2440x1160.png)

This works the same way as it does with Subworkflow Nodes when you choose "Link to Deployment.”

‍

Filter Workflow Executions

Up until now, identifying the context of a Workflow execution required some digging.

Now, the Workflow Deployment Executions table includes a new Executed By column, which shows the context of the Workflow execution. Some example contexts would be: SubWorkflows, Evaluations, Workflow Sandbox, API Request.

This allows you to quickly filter and understand the origin of each execution, making it easier to debug and optimize your Workflows.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/a7cbd59a00056987dbbeb9d7d06e11947acb1863-535x435.png)

‍

Prompt Sandbox Cost Tracking

In the past, it was tough to see how much each Prompt Scenario was costing you, making it hard to weigh the balance between quality and cost.

Now, you can see how much a Prompt run costs to run while iterating on it in Vellum’s Prompt Sandbox. This is particularly helpful when comparing Prompts used by one model vs another so that you can understand their trade-offs between cost and quality.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7a6256bddc96c774f6fc054000156a4dfada58b0-1102x815.png)

Support for OpenAI's Structured Outputs

OpenAI introduced a new way to “force” structured data in their model outputs. They call this new feature Structured outputs which lets developers define the exact JSON schema they expect from the model by using a model parameter or a function call.

Now, this feature is natively integrated in Vellum and you can start using it today.

To use within the context of Function Calling, simply toggle on the Strict checkbox for any given Function Call:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1068b852d5869a70c75de46688552bdeaea9ef36-974x234.png)

To enable Structured Outputs as part of a general OpenAI response, configure the JSON Schema setting as part of model parameters:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/870129e68ee27f09763c02885c1ede0a0f75ad9e-909x612.png)

Both places support upload/download, but for function calling, it's limited to the Parameters JSON schema field, ensuring cross-compatibility with an open specification .

‍

Workflow Updates

## Add Metadata to Workflow Executions

If you wanted to track extra details about your executions, like the source of the request or any custom data, there just wasn’t an easy way to do it before. Now, we’ve introduced Metadata for Workflow Executions, making it easy to track exactly that.

The metadata that you add through API invocations will be visible in the Workflow Execution Details page in the Vellum UI, and you can easily track this information for your executions.

You can find how to set it up in our API docs .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5587591a0a3fa17a531715e6ea4d4eb3d85c4ecf-482x190.png)

## View the Provider Payload on a Workflow’s Prompt Node

Understanding the exact data sent to a provider was a bit of a black box—you couldn’t see how the compiled prompt from a Prompt Node looked in real time.

Now, with this new feature, you can directly view the compiled provider payload on the Workflow’s Prompt Node. Simply click the small “Preview Eye” icon in the bottom-right corner of your prompt to check it out.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/0ed7daecdc679a5169b92430c2c8901acfccc6cc-1553x1435.png)

You can use this feature to debug and ensure that the data being sent is accurate and as expected, thereby reducing errors and improving the reliability of your workflows.

## Workflow Sandbox Latency

You can now view the latency of Workflow Sandboxes and their Nodes by enabling the "View Latency" option in the Workflow Sandbox settings. This feature can be helpful to analyze how long does a specific Workflow run take, and/or how much of that time is consumed by individual nodes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4be7ff37334f487bfb13b3c19621f36f3818dcac-1326x1428.png)

‍

Evaluations Updates

## Asynchronous Exports of Evaluation Reports

Exports of evaluation reports are now asynchronous.

You can export your evaluation report along with its results in CSV or JSON format, and an email will be sent to you once the export is done. Extremely useful for large evaluation dataset, where the export can take a lot of time.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ce3d948291a030aecc4a0bf59748975e35ccfef8-1460x624.png)

## Add Specific Releases to Evaluation Reports

So far, you were able to evaluate only your LATEST Webflow/Prompt deployment in Evaluation Reports. This experience was limited, as many of you wanted to compare other releases in addition to the latest deployment.

Now, you can select specific releases by their tag, allowing you to compare different versions of a Prompt/Workflow deployment.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/021ff36bbfff90326360db99638906a932053425-1408x972.png)

## Evaluation Report History

In V1 of the Evaluation Report, you could only generate a single report at a time, and there was no way to revisit or analyze previously generated reports.

Now, you can access and preview any historical report, allowing you to revisit previous results. This is especially useful for comparing the results of different Evaluation runs, downloading past results, or viewing the Test Cases as they existed at that time.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1a3a12e96771af1824986c9a2e0b4d3753845ac0-2466x1112.png)

‍

Prompts Updates

## Tool Choice Parameter Support for OpenAI

OpenAI recently released a new API parameter called tool_choice to specify when and how a prompt should use a specific tool (function calling setup).

Now, we natively support the set up of that parameter. In the “Configuration” window of a Prompt Node you can select one of the three Tool Choice options. Here’s what these mean:

Auto : The model decides whether to call any provided tools or generate a message Required : The model must call at least one tool, but it chooses which. None : The model won’t call any tool and instead will generate a message.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/585466e3ee1f900adb56635550939219200e8d77-951x748.png)

## Merging Two Adjacent Prompt Blocks

You can now merge one Prompt Block with the one above if they’re of the same Block type. This means that you can merge two Rich Text blocks or two Jinja blocks, but you cannot merge a Rich Text block with a Jinja block.

To do this simply click on the “menu” icon on a Prompt Block, then click “Merge with above Block”.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/05eff05fb86d853f3330cafeff47fabc34fcb65e-1256x496.png)

If you have two different blocks, you can easily convert the type, by clicking on the “menu” icon on a Prompt Block, and converting from Jinja to Rich Text and vice versa.

## Prompt Execution Pages

If you wanted to drill into a single Prompt Execution, previously you’d have to navigate to the Prompt Deployment’s Executions table and try to filter for the specific Execution ID you’re looking for. Now each Prompt Execution (row) has a navigable link accessible from the table:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/251f338b7f209e36467982d26ea587e5ba3c2cf6-738x634.png)

These links take you to a dedicated page for that specific Prompt Execution, where you can view details such as the raw HTTP data exchanged with the provider, recorded actuals, Vellum inputs and outputs, and more!

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/80271f5a0fe3bac859ebc6effd95d1e02c7e413d-1691x643.png)

## Native JSON Input Variable Support for Prompts

Historically, you were able to pass strings and chat histories as dynamic values in the template variables. If you wanted to work with JSON, you'd need to pass it as a string and then parse it inside the Prompt (for example, using json.loads() within a Jinja Block).

Now, we’ve enabled passing of a JSON variable directly as an input to a Prompt. To use it, simply select the JSON variable type from the dropdown.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4a8451b42996fa1ee1afec53ddb0ae5d7da4759c-1470x366.png)

These JSON variables, will render as prettified JSON objects when referenced in Rich Text Blocks and can be operated on directly without the need for json.loads() when referenced in Jinja Blocks.

‍

Deployments Updates

### Deployment Descriptions

You can now add a human-readable description to your Prompt and Workflow Deployments, making it easier for team members to quickly understand what they do without digging into the configuration or control flow.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/002073f628f27741a474918fb773819caf3b586e-1242x734.png)

‍

Quality of Life Improvements

## JSON Schema Editor with $ref Support

Vellum let’s you define JSON Schemas in a few different places throughout the app to do things like define Structured Outputs and Function Calls . Originally, this feature allowed for basic JSON schema definitions and served its purpose well. However, we've identified the need for a more flexible solution—a raw JSON editor that provides greater options for schema customization.As a result, we have now enabled support direct edits via a raw JSON editor.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ce6f68245bc48fb61be809ee23b0e9ef92343ecb-1750x764.png)

From here, you can edit your JSON schema directly. This raw editor allows you to make use of all features supported by the JSON Schema spec , even if they may not yet be supported by our basic form UI. For example, you can now defined references (i.e. $ref) like this: as references:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/09a9c66c99435f7b61acc2e80087b978e49a68e3-876x386.png)

## Support for Excel Files in Document Indexes

You can now upload .xls and .xlsx files for indexing and searching across in Vellum Document Indexes.

## GPT-4o Finetuning

OpenAI’s newest GPT-4o models gpt-4o-2024-08-06 and gpt-4o-mini-2024-07-18 are now available as base models to add as OpenAI finetuned models.

## Anthropic Google Vertex AI Support

We now support using Anthropic’s Claude 3.5 Sonnet, Claude 3 Opus and Claude 3 Haiku Models with Google Vertex AI . You can add them to your workspace from the models page .

## Anthropic Tool Use API for Function Calling

We now support using Anthropic’s Tool Use API for function calling with Claude 3.5 Sonnet, Claude 3 Opus and Claude 3 Haiku Models. Previously Anthropic function calling had been supported by shimming function call XML into the prompt.

# See you in October!

That's a wrap for September!

We hope these updates make your development experience even better. Stay tuned for more exciting features and improvements next month — sign up for our newsletter to get these updates in your inbox!

## Table of Contents

Workflow Replay and Scrubbing Prompt Caching Support New Workflow Editor Beta Release Prompt Node Linked Deployments Filter Workflow Executions Prompt Sandbox Cost Tracking Structured Outputs support Workflows Updates Evaluations Updates Prompts Updates Deployments Updates Quality of Life Improvements
