---
title: "Vellum Product Update | September"
slug: "vellum-product-update-september-2025"
excerpt: "Agent Builder (beta), Custom Nodes, AI Apps, and more for faster and more complex agent building in Vellum."
metaDescription: "Agent Builder (beta), Custom Nodes, AI Apps, Image & Document inputs, and more updates for faster and more complex agent building in Vellum."
metaTitle: "Vellum Product Update | September 2025"
publishedAt: "2025-10-01T00:00:00.000Z"
readTime: "7 min"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
reviewedBy: "Nicolas Zeeb"
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/a99e6d147f09b56a3cb3cef64865f1d027e8c8c1-1280x800.jpg"
---

The only thing scarier than spooky season this October is the amount of updates we shipped to Vellum in September.

This month’s updates make agent building faster and easier than ever with the beta launch of Agent Builder, AI App UI for workflows, and Custom Node creation directly in the UI.

We’ve got lots more features and updates packed in, so let’s go straight in!

## Agent Builder (beta)

Building an agent used to mean dragging and dropping nodes wiring prompts, tools, and UI by hand, then iterating through lots of trial-and-error.

Now spinning up any agent is as easy as prompting Vellum’s Agent Builder with your task and use case. Add in all your context and necessary components to build your agent in minutes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d72bfe1630b87e21432cbe51ec285d893813e020-2046x1656.webp)

Agent Builder can:

Build agents Debug workflows Optimize prompts

All with interactive components surfaced directly in chat to let you trigger workflow and populate suggestions without leaving the chat.

This beta feature is available in all Workflow sandboxes for you to try today ! Read more about Agent Builder here .

## AI App UI for Deployed Workflows

Previously, the only way to use a Workflow once deployed was to call it via API. This meant you'd have to loop in engineers to build a whole backend and frontend to interact with your Workflow.

Now every deployed Workflow can be automatically turned into AI App – complete with a UI that allows you to run and test Workflows in the browser without writing code.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3893a1b8c5657d68250e60ab49b2a2f9981ad920-3024x1890.webp)

Vellum analyzes your deployed Workflow to generate the AI App UI with the appropriate input fields for plug and play use.

This makes it easier than every to spin up AI-powered internal tools and automations, as well as prototypes of new AI-powered user experiences. Learn more in our announcement !

## Create Custom Nodes from the UI

Before, turning bespoke logic into a reusable nodes meant pushing up the code representation of a Workflow.

Custom Nodes can now be created and customized directly in the Workflow UI. With the node’s Open Definition button, you can preview and edit it’s code without leaving Vellum.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ac37c00df260b36cf82e6619d04fe7a400076c4c-1724x636.webp)

Available in the side panel, Custom Nodes allow you to define any custom behavior by specifying:

Input attributes Outputs to return Underlying code to execute

This makes it easier to turn one-off logic into reusable building blocks, speeding up iteration and keeping workflows cleaner. Learn more here .

## Workflows &amp; Prompts: Image &amp; Document Inputs

Passing documents and images into your workflows used to be a meticulous process of using the (admittedly unintuitive) "Chat History" variables.

Now, images and documents can be passed directly as first-class input variables in both Workflows and Prompts.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/73f9084d134ca90cf368327c7cadbbd9555fc975-1212x1022.webp)

With this, it's much easier to build out use cases for data extraction from pdfs, image analysis, and more.

# Workflows

## Agent Node Code Tool Custom Inputs

Before, the code tool could only received what the model populated, limiting control.

You can now pass Custom Inputs to the Agent Node’s Code Tool, even if they aren’t populated by the model.

This gives you deterministic control over tool execution, so you can inject IDs , configs , or other critical parameters without depending on model output.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/54d48938f48bb6ddb791c99cc9d7b463e736f6ce-3183x1887.webp)

# Deployments

## Stack Trace for Workflow Execution Errors

Error surfaces in Vellum used to be shallow, only showed high-level messages with little detail.

Now, you can view the full stack trace for Workflow execution errors directly in Vellum.

This shortens mean time to resolution by making it easy to pinpoint exactly where things went wrong.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1deb38ef3a1a804e89420f13f8ef7ab05f273138-2932x1434.webp)

## Raw Data for Provider Errors

Before, failures were opaque and you couldn’t see the provider’s raw payload after executions.

Now, you can view the provider’s raw response whenever a prompt fails.

This makes it much easier to diagnose issues like rate limits, schema mismatches, or safety filters, as well as drive downstream logic based on this data.

# New Model Support

Google Gemini 2.5 Flash Gemini 2.5 Flash Lite

- OpenAI GPT‑5 Codex Model
# Quality of Life Improvements

## SDK Preview Code Search

It used to be tedious to find the right method or type by scanning the generated SDK preview files.

Now, you can search across filenames and file contents with highlighted matches, making code integrations faster and smoother.

## Custom Node Colors &amp; Icons

Before, there was no way to differentiate custom nodes in your Workflows.

Now, you can customize each node with colors and icons to visually group logic , making scanning and code reviews within Workflows easier.

## Markdown Editor in Note Nodes

Notes in workflows used to be restricted to plain text, making documentation unintuitive and hard to read.

Note Nodes now fully support full markdown , including headers, code blocks, iframes, and more. Markdown enabled notes let you place context directly next to your workflow logic, to make documentation more practical and thorough.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/de59ee374ad9475a0954eb579a298bb8c2555286-1004x1714.webp)

## That’s a wrap for September

That’s a wrap for September. From agent building to streamlining custom code integrations, this round of updates is all about making building easier and faster for the whole team to use Vellum.

We’ll be back next month with more improvements, excited to hear your feedback on these!

{{general-cta}}
