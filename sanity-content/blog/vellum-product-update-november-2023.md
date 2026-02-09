---
title: "Vellum Product Update | November 2023"
slug: "vellum-product-update-november-2023"
excerpt: "November: major Test Suite improvements, arbitrary code execution, and new models!"
metaDescription: "November: major Test Suite improvements, arbitrary code execution, and new models!"
metaTitle: "Vellum Product Update | November 2023"
publishedAt: "2023-11-30T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Welcome to another Vellum Product Update! This one’s a big one 😎 We pushed hard to bring major improvements to LLM Eval (aka Test Suites), Workflows (aka Prompt Chaining), and support for a variety of new models.

# Evaluations

### Workflow Test Suites

Quantitative end-to-end testing of prompt chains has always been a nightmare at best, impossible at worst. But now, you can run Test Suites and perform evaluations against Vellum Workflow ! This powerful functionality helps ensure that your prompt chains meet certain evaluation criteria. You can see a full demo of this in action here .

![A screenshot from Vellum](https://cdn.sanity.io/images/ghjnhoi4/production/f7c713b7c15070c76bef3fd9731710f465f42519-3444x1926.png)

### Code Eval Metric

We’ve seen our customers use Webhook Eval metrics to define all sorts of cool custom eval criteria. This works great and provides ultimate flexibility, but has the added overhead of needing to stand up an API endpoint. To alleviate this, we’ve added the ability for you to write your own custom python code directly from within Vellum to perform bespoke assertions in a Test Suite. When the Test Suite is run, the code is securely executed on Vellum’s backend and the metrics your code produces are shown in the UI.

![A screenshot of Vellum](https://cdn.sanity.io/images/ghjnhoi4/production/5bd1eac723ce33d79f8a7b25f31cf7d07e6dbb55-1682x1718.png)

### Workflow Eval Metric

Now we’re gonna get meta… You can now use a Vellum Workflow as an evaluator for another Prompt/Workflow. This means you can construct a Workflow that calls an LLM and use it to score another LLM. This is particularly useful if you want to evaluate against subjective metrics like “helpfulness” or “politeness.” LLM-based eval is something we’re very bullish on – we’ve already seen some amazing usages of this and are excited to see what you come up with! You can learn more about this powerful feature here .

![A screenshot from Vellum](https://cdn.sanity.io/images/ghjnhoi4/production/cc4fcaef15a6bc5f77712423d4dff0fcf93a6da7-2634x1430.png)

### Multi-Metric Eval

Now that you can define custom evaluators via Workflow Metrics and Code Metrics, it’s likely that you’ll want to judge the output of a Prompt/Workflow across multiple dimensions. For example, maybe you want to check the output for a specific substring AND confirm it conforms to a JSON spec AND use an LLM to grade the output based on “politeness.” To achieve this, you can now configure a Test Suite to evaluate the output of a prompt across multiple evaluation metrics. Learn how to set this up here .

![A screenshot from Vellum](https://cdn.sanity.io/images/ghjnhoi4/production/4cd3965071f2cc1eeafcc897d211249fab647f21-2782x1524.png)

### Metric Names &amp; Descriptions

With the introduction of multiple metrics and new custom evaluators, it’s become more important to make clear what each metric represents. To address this, we’ve added the ability to provide custom names and descriptions for the metrics you define in a Test Suite. These names are then shown wherever the Test Suite is run, and the description is used as help text.

![Screenshot from a metric configuration of the Regex Match metric](https://cdn.sanity.io/images/ghjnhoi4/production/d372cf1ebf929935fedc01c046f2f8539c34af1c-1574x784.png)

### Upload Test Cases Via .tsv Files

Hate commas but love tabs? You can now define Test Cases within a Test Suite by uploading tab-separated (.tsv) files.

![A screenshot from Vellum on how to upload test cases from csv](https://cdn.sanity.io/images/ghjnhoi4/production/3cb9bb701f245f80d1995c2e0065495eb588b371-1202x974.png)

# Workflows

### Code Nodes

Templating Nodes have allowed you to perform basic data transformations via Jinja 2 templating syntax for some time now. While flexible, nothing beats good ol’ fashioned code. For those that want ultimate flexibility, you can now run arbitrary python code securely from within a Vellum Workflow as part of the new “Code Execution Node."

![A screenshot of the Code Execution Node from Vellum](https://cdn.sanity.io/images/ghjnhoi4/production/807820743623ec6b0c852b74bd9ad9adad35353f-1226x894.png)

### Chat Widget

There’s a whole new panel dedicated to testing chat-based Workflows. It’s now far smoother to simulate the interaction between an end-user and your AI-powered Workflow. You can see a full demo of this in action here .

![A screenshot from the Chat Panel where you can test chat-based Workflows](https://cdn.sanity.io/images/ghjnhoi4/production/18d8addf0ac21688ea55f45d1e841aa1c99f1e4b-3444x1990.png)

### Support for Numerical &amp; JSON Inputs

It’s now possible to provide numerical and JSON values as inputs to a Workflow.

![A screenshot from the input variable panel, showcasing that you can now provide string, numerical and JSON values as inputs to a Workflow](https://cdn.sanity.io/images/ghjnhoi4/production/41649ca801fbe6adf7e0764dbea6021abdbee8e4-1092x1230.png)

### Looping Support

You can now perform loops in a Workflow. Looping is often used in conjunction with a Conditional Node that checks to see if a prompt has been executed a specific number of times and if so, exiting the loop.

### Search Across Workflow Deployment Executions

![Screenshot from a Workflow Deployment executions and the filtering option](https://cdn.sanity.io/images/ghjnhoi4/production/0bf2774cbafefc18848005c159d2604f17ce9c3e-2872x1808.png)

### Archiving/Unarchiving Workflow Sandboxes

Don’t need a Workflow anymore but want to keep it around just in case? You can now archive/unarchive Workflow Sandboxes (and also prompt Sandboxes!)

![Screenshot from a prompt sandbox and the settings associated with it](https://cdn.sanity.io/images/ghjnhoi4/production/0fffbf928387896026166444423e51f6651d8dd4-972x464.png)

## First-Class Model Support

### OpenChat 3.5 on Replicate

You can now use the open-source OpenChat 3.5 model directly within Vellum, hosted by Replicate . This is an exceptional model and is on-par with ChatGPT for many chat-based use cases. Give it a try!

### Claude 2.1

We now support the use of Anthropic’s new Claude 2.1 model. This model features a 200k context window and 2x decrease in hallucinations. With the release of this model, Anthropic now supports System messages (already supported within Vellum) and the use of tools/function-calling in beta (support will soon be added to Vellum).

### New OpenAI Models

OpenAI released 3 exciting new models, all of which are available within Vellum: gpt-3.5-turbo-1106, gpt-4-1106-preview, gpt-4-vision-preview. Note that models in preview will change and should not yet be used in production! First-class support for new OpenAI features such as JSON Mode and the ability to add images are coming soon.

### Custom Model Support

![A screenshot from two custom model options, self-managed OpenAI on Azure and a fine-tuned OpenAI model](https://cdn.sanity.io/images/ghjnhoi4/production/31667ef8de8894d5dd8951b65b9bb7b7c489a697-1988x554.png)

### OpenAI on Azure

You can now use OpenAI models hosted within your own Microsoft Azure account securely from within Vellum. You can go to the Models page to configure the integration.

### Fine-Tuned OpenAI Models

You can now add fine-tuned OpenAI models to Vellum directly through the UI such that you can then use these models throughout Vellum. You can go to the Models page to configure the integration.

### Claude on Bedrock

You can now use Claude models hosted within your own AWS Bedrock account securely from within Vellum. You can go to the Models page for instructions and configuration.

# And That’s a Wrap

It’s been a busy November but we have no intentions of slowing down going into December. It’s likely you’ll see even deeper improvements to Workflows, Test Suites, and more! Thanks to all of our customers who have pushed us to move fast and ship the tools they need to productionize their AI use-cases. Keep the feedback coming!

https://discord.gg/6NqSBUxF78

See you next month!
