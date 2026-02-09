---
title: "Partnering with Composio to Help You Build Better AI Agents"
slug: "vellum-composio-new-partnership-for-ai-agent-building"
excerpt: "Building AI agents is 10x easier with 10,000+ tools and built-in LLM tooling support"
metaDescription: "Building AI agents is 10x easier with more than 10,000 tools and built-in tooling support for your LLMs"
metaTitle: "Vellum + Composio: Build Powerful AI Agents Faster"
publishedAt: "2025-08-12T00:00:00.000Z"
readTime: "6 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/a3e48ba45e568957b363f6422b6e69026d396755-1920x1080.heif"
---

AI agent building just got easier with Vellum and Composio. Today, we’re excited to share our partnership with Composio, a leading AI connector platform with 10,000+ tools (Google Drive, Notion, Jira, Linear, Trello, etc.) that can adapt to your AI solutions.

We’re now offering first-class support for Composio tools in our newly launched Agent Node, enabling our customers to build even more powerful agents.

Thanks to this partnership, hundreds of agentic use cases just became 100x easier to build with Vellum. Sing up here , and start building! Here are some ideas to get you started:

An agent that researches competitor profiles and sends a report straight to your inbox An agent that gathers all Jira tickets and sends a weekly report to the team An agent that searches the internet and creates SEO-optimized articles in your Notion An agent that monitors all new Jira bugs and sends Slack notifications to the team

Tomorrow (9/13) at 4 pm EST, Vargas, our founding engineer, will demo how to start building agents using the Agent Node and your Composio tools. Save your spot here!

The sections below provide a full tutorial on how the Agent node works, how to integrate with Composio and start using it today.

## Quick primer on the Agent Node

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4a049997805b81347a43d348cd45a4f48d9854ab-1182x428.png)

The Agent Node streamlines tool calling within Vellum Workflows by automatically handling OpenAPI schema generation, loop logic, and function call output parsing. This eliminates the tedious manual work traditionally required for implementing function calling patterns.

### Key Features

The Agent Node provides several advantages over manual function calling implementation:

Automatic Schema Generation : No need to manually define OpenAPI schemas for your tools Built-in Loop Logic : Automatically handles the iterative calling pattern until a text response is received Output Parsing : Automatically parses function call outputs without manual intervention Multiple Tool Support : Configure multiple tools within a single node

### Configuration

The Agent Node requires two main components:

1. Model and Prompt Configuration

Configure the LLM model and prompt that will determine when and how to call the available tools.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8d8fa164f3222fe9d5dc305680b42daac6fe764b-896x1356.png)

2. Tool Definitions

Define the tools that the model can call. The node automatically infers the required schema for each tool type. The Agent Node supports three types of tools:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d728645a428d151131abf71db041c84cb89ef535-1368x770.png)

For more context about each of the tool types, and the outputs you can get from this Node, you can read in the official documentation page.

## How to use the Agent Node with Composio tools

To use the Agent Node with Composio, you’ll need to have:

An account with Composio (they have a free tier with up to 20k tool calls/m) An account with Vellum

## Composio setup

Now, to start using tools from Composio in Vellum, you’ll need to do two things:

You’ll need to authenticate the tools in your Composio account Create and copy your Composio API key

Tool authentication

To do that, head to your profile, and go into the Auth Configs section. Once you’re there, click on the “Create Auth Config” button:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f4c4e3270c3c77f5b7d4816569ab13faceb62aa3-3594x1189.png)

Once you click that button, you’ll be able to select the tool that you want to authenticate with (see first image). From there if you select “Gmail” for example as your tool, you’ll be able to use the OATH 2 option. You don’t change anything in the settings, and just click on “Create Gmail Auth Config” (see second image):

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d2260de14ee8332f003841e65487e5d71c58acc3-1816x1686.png)

Once you initialize the Gmail tool, you’ll arrive to the configuration for that specific tool. In it you’ll need to add your account by clicking on “Connect Account” where you’ll be asked to connect your gmail account via OAUTH 2 authorization:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/50d5ba18196715816a0856b2a81f8713633881fe-3586x1892.png)

Once you click “Connect Account” you’ll see a pop up asking you to add a User ID. Just type “default” here, and you should be able to authenticate:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ecfa86c917e7fb76737890439ba74e36b8666d30-1026x628.png)

If the authentication was successful, you’ll be able to see your account listed under this configuration, with status “Active”:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/eaec14b841bb8ae17a34e16d2b5f63173430516b-3180x1036.png)

Getting your Composio API

Before you go into your Vellum workspace, you’ll need to create an API key from Composio. To do that, navigate to “Settings” and click “Create API key”. Once you have the API key, copy it to your clipboard.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5b52c3b5e7eee5aef273c6802bd7c081f4cffecd-3586x1576.png)

The next steps are going to happen in Vellum.

## Vellum setup

In Vellum, you’ll need to do two things:

Setup your Composio secret as an environment variable once (You can do this from your Workspace setting, or directly on the Agent node. Bellow we show the former example) Add an Agent Node, select the Composio tool type and connect with your tools

Adding your Composio secret

In Vellum, navigate to your Workspace Settings, where you’ll find the Environment variables section. Then, click on “Add Environment Variable”:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/43a40806b4eef5b860082e099d6d329f5355ce05-3584x1778.png)

From there you can add your API key, and create a Variable:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/bb25714c6069706616fe5566a746c24c6237063a-1274x978.png)

Now you’re ready to use your Composio account in Vellum Workflows, in the Agent Node!

Using Composio tools in the Agent Node

Now that you have Composio connected with Vellum, you can start giving your LLMs tools to work with. Once you select the Agent Node, in a given workflow, and you select “Composio tools” from the Tool dropdown, you’ll be able to select specific tools that you’d like to enable for a given LLM call:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/afd26df5b3d6a63534caf12ba8aaa524ef2615f1-1854x1324.png)

Once you enable one tool, for example “Create an email draft” you’re going to see the tool selection in the side-nav, and the LLM call will be ready to use it under the hood:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4d2285779b1e5095838db871bf92becab1f191a2-896x768.png)

So for example, if you write in the prompt something like “ Send an email draft with 5 quotes to "sam@open.ai”, the LLM model will know to create the 5 quotes, and open an email draft in Sam’s inbox containing that output!

And there you have it folks! Looking forward to what you can build next! Signup to Vellum today!
