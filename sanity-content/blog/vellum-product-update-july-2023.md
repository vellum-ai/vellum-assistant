---
title: "Vellum Product Update | July 2023"
slug: "vellum-product-update-july-2023"
excerpt: "We've continued to build our platform more, here's a look at the latest from us and a sneak peak of what's coming!"
metaDescription: "Product Update July: We've continued to build our platform more, here's a look at the latest from us and a sneak peak of what's coming."
metaTitle: "Vellum Product Update | July 2023"
publishedAt: "2023-07-27T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Following the exciting public announcement of our seed round , we’ve been hard at work doubling down on building out our platform to help companies create production use cases with LLMs.

If you’re already a Vellum customer, you may have seen some of these already, but here’s a quick recap of everything new within the past month!

## Model Support

### Llama2 &amp; MPT instruct

Last month we added support for our first open source LLM ( falcon-40b-instruct ). This past month, we’ve continued to add native support for open source LLMs – notably, the Llama2 series and MosaicML’s mpt-instruct series. We’re already seeing some exciting results from these models and encourage folks to check them out! You can compare them side-by-side against your own benchmarks and other models via Vellum’s Playground.

![](https://cdn.sanity.io/images/ghjnhoi4/production/9a84d3b82526c1e34328f2626c833824f114a8aa-1800x1054.png)

### Claude 2

We also now provide native support for Anthropic’s Claude 2 . If you need longer context windows and low latency, definitely give it a try!

### Embedding Models for Search

Vellum Search now supports multilingual-e5-large – an awesome new open source embedding model that requires very little configuration to get great results.

Vellum Search is a great way to quickly get started on use-cases that require vector search and document retrieval, as you don’t have to manage any of the infrastructure and can simply hit APIs to upload documents and search across them.

### Fine-Tuned Models

Vellum has begun to partner with select customers to provide fine-tuned open-source models that produce higher accuracy, lower latency, and lower costs compared to off-the-shelf closed source models. The early results look very promising!

If you’re interested in piloting this with us, contact us here .

‍

## Playground

Vellum’s Playground is the centralized place where technical and non-technical folks alike collaborate on prompts. Some people spend hours at a time in Playground, and so we continue to invest in making it a useful and powerful tool.

### Function Calling

One of the biggest additions to Playground is native support for OpenAI’s new function-calling functionality. You can now experiment with the entire function-calling lifecycle in Vellum, including using our UI to easily define new functions.

This big update probably warrants its own whole post – to learn more, check out the demo video here .

![](https://cdn.sanity.io/images/ghjnhoi4/production/68bf48947cc74c57efc30e898175750425a57b93-1792x1011.gif)

‍

### Latency Tracking

You can now enable latency tracking to see how long it takes for an LLM’s response to start and finish coming back. These metrics are averaged over all Scenarios so you can get a feel for how fast a prompt/model combination will be.

![](https://cdn.sanity.io/images/ghjnhoi4/production/c4a53114a5ad14bc913f1a436f4445c4544e00c0-994x743.gif)

‍

### Manual Evaluation &amp; Note-Taking

Vellum has had automated output evaluation for a while now, but sometimes, you just want to manually indicate which outputs were good or bad, or leave notes on a given output so that you can keep track of your thoughts. Now you can.

![](https://cdn.sanity.io/images/ghjnhoi4/production/c5e871a1dfc4efe88b2e4a102f8628bfc0032d52-1792x1011.gif)

‍

### Renaming Prompts &amp; Scenarios

Renaming Prompts and Scenarios is useful to keep track of the intent of each. Now you can edit their names inline.

![](https://cdn.sanity.io/images/ghjnhoi4/production/e665bbca177df75cb08349cdcd2f3176829f20b1-1774x1009.gif)

‍

### Previewing Compiled LLM API Payloads

Vellum acts as an abstraction layer between you and the many LLM providers and models out there. However, sometimes it’s helpful to see what exactly Vellum is sending to the LLM via its API. Now you can via the Prompt fullscreen editor.

![](https://cdn.sanity.io/images/ghjnhoi4/production/a67b5848a09cb0ff81170b95da6572eeeaf208e4-1792x1011.gif)

‍

### Copy/Pasting Chat Messages

When iterating on prompts for AI chat applications, it’s likely that you’ll have a number of different Scenarios to test out conversation flows. Sometimes these flows are built up on one-another and it can be useful to start from an existing conversation. You can now cop/paste chat messages from one Scenario to another to help with the process.

![](https://cdn.sanity.io/images/ghjnhoi4/production/6a69eafee5b13cf7eb42c9af2b4145fe784753f9-1792x1011.gif)

### Streaming

In our previous Product Update , we announced support for streaming results of OpenAI models back to the Playground UI. Now, we support streaming for Anthropic and Cohere models as well.

‍

## Deployments

### Streaming

In addition to adding streaming support for Anthropic and Cohere models to Playground, we also now have streaming support for these models in Vellum Deployments. You can learn more about our streaming API in our API docs here .

### Filtering &amp; Sorting Completions

Vellum provides observability and logging for all LLM requests made in production. However, it’s been historically hard to find specific requests that you may need to debug. Now, you can filter and sort on most columns in the Completions table. As you apply filters/sorting, the browser’s url will be updated. You can copy this url and refer back to it, or share with others, to pick up where you left off.

![](https://cdn.sanity.io/images/ghjnhoi4/production/43e35ef81121475b3e6fd5f168d9a6bcce145e31-1792x1095.gif)

### Quality of Life

Sometimes it’s the little things. In addition to cranking out new features, we hope to make Vellum more of a joy to use in general. This will be a big focus of next month, but we’ve already got a head start with:

Improved Test Suites Infrastructure – you can now run test suites containing hundreds or even thousands of test cases Unified UI Components – more and more of the objects you see in Vellum have been standardized and made responsive to screen size Correctly Formatted Copy/Paste – Copy/pasting the output of prompts from Playground into other systems will now maintain the original format.

## Sneak Peak

If you’ve made it this far, congrats! You get a sneak peak of something big that we’ve been hard at work on and will announce more formally soon… Vellum Workflows!

![](https://cdn.sanity.io/images/ghjnhoi4/production/8d418fb8109b94ed4a03e1ab319d2e96e4bc4d43-2802x1522.png)

Vellum Workflows is our answer to the wild world of experimenting with, versioning, and monitoring chains of LLM calls. More on this soon, but if you want to join our closed beta program for Workflows, you can contact us here .

And that’s a wrap! Thanks for following along and to our customers – thank you as always for your amazing product feedback! Vellum wouldn’t be what it is today without you all pushing us.
