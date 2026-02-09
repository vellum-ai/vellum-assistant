---
title: "How Narya's team uses Vellum for auto data labeling & deployments"
slug: "how-naryas-engineers-do-automatic-data-labeling-and-evaluate-deploy-models-in-minutes-with-vellum"
excerpt: "Learn how Vellum helped Narya.AI save time and make AI easy for everyone on their team."
metaDescription: " Learn how Narya.AI utilized Vellum for automated data labeling, quick AI prototyping, and deployment. This approach saved their data scientists 30% of their time and enabled developers with no AI background to test and deploy models independently."
metaTitle: "How Narya's team uses Vellum to collaborate on AI development work "
publishedAt: "2023-10-25T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Prototype and deploy AI Apps with the whole team."
authors: ["Anita Kirkovska"]
category: "Customer Stories"
tags: ["Evaluation", "Deployments"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/a1972cc0c079b523bc303a8cf227550304469510-1165x627.png"
---

Prototyping, and deploying LLM models can be time-consuming tasks that typically require experts to handle them.

Imagine cutting down that time by 30% and letting even non-experts take the wheel.

That's exactly what Narya.AI did using Vellum.

Their data scientist experts got a 30% time break, and their Solidity engineers who didn't have deep experience in AI could now test and deploy models by themselves.

Furthermore, they were able to create synthetic datasets using the completion logs from their deployed apps. This allowed them to train open-source models for production while automating the data labeling process altogether.

Want to know how?

Keep reading.

## Who is Narya.AI and what brought them to Vellum?

Narya.AI enables Solidity developers to test their smart contracts 10x faster, using a simple AI-recommendation engine. Their no-code lego-style platform uses AI to generate proper tests for smart contracts, and they use LLM-powered agents that identify vulnerabilities in the code, test against past hacks, and provide suggestions for improving Solidity code from the security standpoint.

To do this, Narya's AI expert Eldar Akhmetgaliyev knew they had to gather lots of data on code issues, save it, and use it to train the model.

However, they didn't want to go with outdated machine learning (ML) systems like DataStore. Those systems require manual data collection and labeling, and didn’t feel very LLM native.

They also tried popular ML ops Python libraries, but those required so many unnecessary engineering steps. Each time you want to deploy a model, you still need to set up a Flask app.

Running a smooth prototyping, evaluation and deployment process by both ML and Non-ML developers was a priority, and they quickly onboarded on Vellum.

## How Narya.AI &nbsp;uses Vellum today?

Narya’s team approached Vellum with the goal of automating data labeling using LLMs, but soon realized that Vellum's tooling could offer much more.

Today, Vellum powers several of their apps.

They have tested over 50 prototypes and have deployed more than 10 prompts using Vellum.

### → Quick prototyping &amp; Reliable deployment

Narya's team can build prototypes in just a few minutes.

They usually discuss their use-case internally, write down the prompt instructions, and test it with different models and parameters within Vellum.

If the output passes their evaluation tests, they quickly deploy the model using Vellum's simple API interface. On their end, they also have a function that continuously calls this API and parses the results in the desired format.

### → Automated data labeling &amp; fine-tuning open source models

When it came to data labeling, the top priority was to store examples and automate the process downstream.

Narya.AI discovered that GPT-4 achieved a remarkably close level of precision to humans for many labeling problems. With this in mind, they decided to avoid manual data labeling and instead use LLMs for automated data labeling.

Within Vellum, they quickly set up prototypes using few-shot prompting and even extracted examples from connected embedding models.

They created and evaluated more than 50 prototypes to date.

Additionally, they have deployed over 10 models in production, allowing Vellum to continuously log all user completions. Now, Narya.AI is using those completions to fine-tune open-source models and avoid hitting rate limits with commercial LLM models.

This kind of speed is crucial for a startup like theirs, as they need to iterate and ship quickly.

## What impact has this partnership had on Narya.AI ?

It takes only a few minutes for Narya’s team to build prototypes &amp; deploy them in their apps.

Eldar, the data science expert on the team, is doing his work 30% faster. However, more importantly, he emphasizes the tremendous value Vellum brings to the rest of the team.

The Solidity and Front-end developers on the team wrote models in Vellum, without any challenges.

> “Non-ML developers were now able to evaluate and deploy models. It's not just 10X faster work for them; it's like they couldn't have done it without Vellum. And if when they had questions about the product, Vellum’s superb customer service ensured uninterrupted workflow for them”

Right now, they’re looking to fine-tune open-source models using the datasets generated in Vellum and we’re here to support them in that process.

We enjoy collaborating with Narya.AI and are always striving to improve our product to better suit their needs.

## Want to try Vellum?

Vellum provides the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production — no custom code needed!

If you're looking to incorporate LLM capabilities into your app and want to empower your Non-ML engineers, we're here to assist you.

Request a demo for our app here or reach out to us at support@vellum.ai if you have any questions.

We’re excited to see what you and your team builds with Vellum next!
