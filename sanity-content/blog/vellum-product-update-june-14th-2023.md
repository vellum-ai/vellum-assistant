---
title: "Vellum Product Update | June 14th, 2023"
slug: "vellum-product-update-june-14th-2023"
excerpt: "We've shipped a lot of features recently, here's a look at the latest updates from us!"
metaDescription: "Product Update for June: Streamlining support, Test Suites, API improvements and many other features"
metaTitle: "Vellum Product Update | June 14th, 2023"
publishedAt: "2023-06-14T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Hello everyone and welcome to the first official product update from Vellum! We plan to do these more regularly to share what we’ve shipped on and what’s coming next, but for this first one, we have quite a build-up of new features from the past few weeks to share!

Let’s go through each, one product area at a time.

## Playground

#### Streaming Support

We’ll now stream output immediately as it becomes available, giving quick insight into whether things are going off track.

![](https://cdn.sanity.io/images/ghjnhoi4/production/5810f8619c87fd784f15896297060f3faaa6d80e-1792x983.gif)

#### Auto-Save

We’ll now automatically save progress after 60 seconds of inactivity. The save button is now moved to the top right and indicates whether there are unsaved changes.

![](https://cdn.sanity.io/images/ghjnhoi4/production/ccb6ee3bbd3590991b96f31274577cf52956f81c-818x300.png)

#### Jinja Templating Support

Vellum prompts now support Jinja templating syntax , allowing you to dynamically construct your prompts based on the values of input variables. This is a powerful feature that our customers (and even we!) are only just beginning to understand the full capabilities of.

![](https://cdn.sanity.io/images/ghjnhoi4/production/665c3c4e6a3899c8296347febb7c23676b3a4327-1714x420.png)

#### Support for the Open Source Falcon-40b LLM

Open Source LLMs are becoming more and more powerful and increasingly tempting to use. Falcon-40b is one of the best available today and is worth taking a look at if you’re trying to reduce costs.

![](https://cdn.sanity.io/images/ghjnhoi4/production/8d6264a9a17d3c03457e24d553c1bfd80650ecc8-888x678.png)

## Search &amp; Document Retrieval

We’ve made a multitude of improvements to Vellum’s document indexing and semantic search capabilities, including support for:

Uploading more file formats: .txt, .docx, .pdf, .png, .jpeg Additional embedding models, including the widely used hkunlp/instructor-xl from Hugging Face. Connecting to external data sources like Notion, Slack, and Zendesk so that you can search across your own internal company knowledge bases. More sophisticated text chunking strategies

![](https://cdn.sanity.io/images/ghjnhoi4/production/906644e05eb8e0a323710fcc601004fc879200fa-3584x1964.png)

## Role-Based Access Control

We now offer Role-Based Access Control to give enterprises greater control over who’s allowed to do what. You can now have non-technical team members iterate on and experiment with prompts, without allowing them to change the behavior of production systems. Once they get to a better version of a prompt, they can get help from someone who has broader permissions to deploy it.

![](https://cdn.sanity.io/images/ghjnhoi4/production/b979f945af4e402d08c6896d5437b996504d7361-3584x1968.png)

![](https://cdn.sanity.io/images/ghjnhoi4/production/1e38ccce3128943811236a8b26a9e5803dfcdeaa-3584x1970.png)

## Test Suites

We continue to invest heavily in testing and evaluating the quality of LLM output at scale.

#### New Webhook Evaluation Metric

You can now stand up your own API endpoint with bespoke business logic for determining whether an LLM’s output is “good” or “bad” and Vellum will send you all the data you need to make that decision, then log and display the results you send back. You can learn more here .

![](https://cdn.sanity.io/images/ghjnhoi4/production/15c926b8399bb84a50c51df57e8a0d38c4063949-3584x1966.png)

#### Re-Running Select Test Cases

You can now re-run select test cases from within a test suite, rather than being forced to re-run them all.

![](https://cdn.sanity.io/images/ghjnhoi4/production/37bd8447329a0dd1cd309274bc8fdf45675dd8aa-1792x984.gif)

## API Improvements

One philosophy that we have at Vellum is that anything that is possible through the UI should be possible via API too. We continue to invest in making Vellum as developer-friendly as possible.

New API Docs

We have a slick new site to host our API docs, courtesy of our friends at Fern . You can check out the docs at https://docs.vellum.ai/

![](https://cdn.sanity.io/images/ghjnhoi4/production/9fac65ea5b54f59ce78cf302278b0dffff59bcd8-3584x1968.png)

#### Publicly Available APIs

We’ve exposed more APIs publicly to support programmatic interaction with Vellum, including:

POST | https://api.vellum.ai/v1/generate-stream Used to stream back the output from an LLM using HTTP streaming POST | https://api.vellum.ai/v1/test-suites/:id/test-cases Used to upsert Test Cases within a Test Suite POST | https://api.vellum.ai/v1/sandboxes/:id/scenarios Used to upsert a Scenario within a Sandbox POST | https://api.vellum.ai/v1/document-indexes Used to create a new Document Index

## Community &amp; Support

We’ve launched a new Discord server so that members of the Vellum community can interact, share tips, request new features, and seek guidance. Come join us !

‍

# In Summary

We’ve been hard at work helping businesses adopt AI and bring AI-powered features into production. Looking ahead, we’re excited to tackle the problem of experimenting with, and simulating, chained LLM calls. More on this soon 😉

We welcome you to sign up for Vellum to give it a try and subscribe to our newsletter to keep up with the latest!

As always, thank you to all our customers that have pushed us to build a great product. Your feedback means the world to us!

‍
