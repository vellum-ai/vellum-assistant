---
title: "Vellum Product Update | October 2023"
slug: "vellum-product-update-october-2023"
excerpt: "October: universal LLM support, new Test Suite metrics, and performance"
metaDescription: "October: universal LLM support, new Test Suite metrics, performance, and more"
metaTitle: "Vellum Product Update | October 2023"
publishedAt: "2023-10-31T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Wait, it’s already November?! 😱 That means another product update! Here’s all that’s new to Vellum from October, 2023. This month we focused on making it possible to integrate with any LLM hosted anywhere, deepening what’s possible with Test Suites, and improving the performance of our web application. Let’s take a closer look!

‍

## Model Support

### Universal LLM Support

We’ve been hard at work for the past two months rebuilding the core of Vellum’s backend. The end result? We can now support just about any LLM, anywhere, including custom and privately hosted models.

We’ve since helped customers integrate:

Fine-tuned OpenAI models OpenAI models hosted in Microsoft Azure Anthropic models hosted in AWS Bedrock WizardMath models hosted on Replicate And more!

This means you can use Vellum as a unified API for interacting with any LLM, as well as benchmark them against one another.

If you have a custom model hosted somewhere we don’t yet support, let us know! We’d happily add it to our queue.

### Models Page

With the introduction of universal LLM support, we’ve realized that it’s more important than ever to be able to discover what models are out there, what they’re good for, and hide those that aren’t relevant to your organization. To that end, we’ve introduced the new “Models” page, accessible from the side navigation. Larger organizations might use this to restrict which models their employees are allowed to use within Vellum.

![](https://cdn.sanity.io/images/ghjnhoi4/production/d98cc5b6c2c9fb3e95ab5376a7e94056fcd626f7-3456x1986.png)

## Test Suites &amp; Evaluation

LLM Evaluation is a big focus for us right now. The first new features to come out the gate here are…

### JSON Validity Eval

You can now configure a Test Suite to assert that the output of a Prompt is valid JSON. This is particularly useful when building data extraction prompts or when using OpenAI’s function calling feature.

![](https://cdn.sanity.io/images/ghjnhoi4/production/207345e0c0efd4fc058d9ab5a257ec009cb03d61-3456x1986.png)

### JSON Schema Match Eval

In addition to asserting that a Prompt outputs valid JSON, you might also want to assert that the output JSON conforms to a specific shape/schema. This is where JSON Schema Match comes in.

You can use Test Suites to define the schema of the expected JSON output, and then make those assertions. This is crucial when developing data extraction pipelines.

![](https://cdn.sanity.io/images/ghjnhoi4/production/82613f551db9dd9f445a7bec7b21928dbbb40ef1-1608x1572.png)

### Cancelling Test Suite Runs

It used to be that once you kicked off a Test Suite Run, there was no going back. Now, you can cancel a run while it’s queued/running. This is particularly helpful if you realize you want to make more tweaks to your Prompt and don’t want to waste tokens on a now-irrelevant run.

![](https://cdn.sanity.io/images/ghjnhoi4/production/dceafd9ca84a87fb013eba8d3cfa72a19f4ccd57-2730x894.png)

## Prompt Deployments

### Monitoring Data Export

Vellum captures valuable monitoring data every time you invoke a Prompt Deployment via API and provides a UI to see that data. However, we’re a strong believer that this data is ultimately yours and we don’t want to hold it hostage.

To follow through on this commitment, we’ve made it easy to export your Prompt Deployment monitoring data as a csv. This can be helpful if you want to perform some bespoke analysis, or fine-tune your own custom model. Here’s an in-depth demo of how this works.

![](https://cdn.sanity.io/images/ghjnhoi4/production/8e97439f0a0f72916911fbf4a6a9722460a51197-3456x1918.png)

## UI/UX Improvements

### Performance

We’ve made a big push this month to make our Prompt and Workflow engineering UIs more performant. You should now be able to experiment with complex Prompts &amp; Workflows without being slowed down by lagginess. If you experience any lingering issues, please let us know!

‍

### Back-linking from Workflow Sandboxes to Deployments

It’s always been possible to navigate from a Workflow Deployment to the Sandbox that generated it. However, we didn’t have any UI to perform the reverse navigation. Now we do!

![](https://cdn.sanity.io/images/ghjnhoi4/production/39dea0f15b83978b358ab8db51ad003cb7e93bc6-3456x1986.png)

We’ll soon have the same for Prompt Sandboxes → Deployments.

### Re-sizing Workflow Scenario Inputs

You can now re-size the inputs to Workflow Scenarios so that you can see all the contents within.

![](https://cdn.sanity.io/images/ghjnhoi4/production/2b5319c93cd215f7e2e21749b01f2841d0e04221-1728x992.gif)

‍

## API

### New Go&nbsp;Client

We now have an officially supported API&nbsp;Client in Go! 🎉 You can access the repo here . Big shout out to our friends at Fern for helping us support this!

![](https://cdn.sanity.io/images/ghjnhoi4/production/3b8d5fd8736a556f3e6eef09fc94985c19520151-3456x1918.png)

‍

## Looking Ahead

We’re already well-underway working on some exciting new features that will roll out in November. Keep an eye out for Test Suite support for Workflows, a deepened monitoring layer, UI/UX improvements for our Prompt &amp; Workflow sandboxes, and more!

As always, please continue to share feedback with us via Slack or our Discord here: https://discord.gg/6NqSBUxF78

See you next month!

‍
