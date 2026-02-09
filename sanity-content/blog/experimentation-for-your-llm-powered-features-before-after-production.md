---
title: "Testing LLM applications features  - before & after production"
slug: "experimentation-for-your-llm-powered-features-before-after-production"
excerpt: "Tips to experiment with your LLM related prompts"
metaDescription: "LLM Testing: Discover valuable tips and strategies for experiment with your LLM prompts and optimize their performance."
metaTitle: "How to test llm output - before & after production"
publishedAt: "2023-06-12T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Akash Sharma"]
category: "Guides"
tags: ["Deployments", "Evaluation", "Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/8265b37a13172eb4fc08fd10ed88fb0ca33f495b-1107x762.png"
---

## Introduction

This latest blog from us discusses the importance of experimentation and testing for LLM features both before and after they are put into production. LLMs are probabilistic, and therefore, need to be tested with various prompts and scenarios/test cases to ensure their reliability and performance. Creating a unit test bank, regression testing, and A/B testing are some of the methods that can be used to evaluate the quality of LLM features. Once in production, improvement to cost/latency is possible by collecting high quality input-output pairs and using them to fine-tune models.

## Pre-production

### Tracking prompt templates

Tracking variations while iterating on prompts before sending them to production is essential for maintaining control over your LLM feature development process. By keeping a record of prompt templates, choice of foundation model and model parameters, you can easily revert to a previous version if needed, as even minor changes in wording or parameters can significantly impact the model's performance on your test cases.

This is particularly helpful when multiple people are collaborating on prompt development. A well-documented history of prompt iterations ensures that everyone stays informed about the changes made and their effects on the application's performance. It also facilitates effective communication among team members, enabling them to understand the rationale behind each modification and learn from past experiences. We’ve usually seen companies do this in Excel spreadsheets and Notion documents.

### Unit test bank

Creating a unit test bank before deploying LLMs to production is a proactive approach to ensure prompt reliability in production. The test bank should comprise scenarios anticipated in production, think of this as QAing your feature before it goes to production. The prompts should "pass" these test cases based on your evaluation criteria. We wrote a blog about how to evaluate quality of LLM features a few weeks ago, but in summary, the evaluation approach depends on type of use case

Classification: accuracy, recall, precision, F score and confusion matrices for a deeper evaluation Data extraction: Validate that the output is syntactically valid and the expected keys are present in the generated response SQL/Code generation: Validate that the output is syntactically valid and running it will return the expected values Creative output: Semantic similarity between model generated response and target response using cross-encoders

## Post-production

### Regression testing

As you modify prompts, it's essential to verify that existing functionality remains intact. One approach is to replay historical requests against the updated prompt or model. Run a script to take the inputs sent to the original prompt/model and pass them to your updated prompt/model. Do a side by side comparison. By comparing the outcomes, you can ensure that your changes haven't introduced any unexpected behavior, thus preserving the overall performance and stability of your LLM applications.

### A/B testing

If you’re not sure about which of your final prompts to put in production, A/B testing them might be a good idea. You could A/B test prompts from different model providers too! By running multiple prompts side by side, you can gather valuable user feedback to determine which prompt performs better in real-world scenarios. This feedback can be collected implicitly, through observing user interactions and engagement, or explicitly, by directly asking users for their input via thumbs up/thumbs down. When this is run for sufficient time it should be clear which prompts are performing better. It’s important to set up the A/B testing infrastructure correctly: make sure you correctly track which users get which prompts and measure their feedback too.

### Keep building your unit test bank

You already have a unit test bank before your features were sent to production. As prompts encounter unexpected inputs or scenarios that produce undesirable behavior, these new cases should be documented and added to the unit test bank. When future prompt iterations are done, they must pass these additional tests/edge cases before deploying to production. This approach ensures your features remain robust, don’t have regressions and enhance performance in handling real-world edge cases.

### Experiment with fine tuning once you have enough training data

As open source models continue to get better, fine-tuning open source models becomes a viable option once your LLM application has accumulated enough training data in production. This technique is called model distillation: you have enough ground truth data through closed source models (like GPT-4 and Claude) and you can use that to train your own models. Using open source models can be hugely beneficial: they could be cheaper, faster, more customizable and more privacy compliant since your data is not sent to external model providers. While experimenting with open source models, it’s important to maintain quality and only then look for other improvements.

## Want to experiment with your LLM powered features?

Building the infrastructure for unit testing, regression testing, A/B testing &amp; open source model fine tuning takes a lot of engineering capacity for internal tooling, time that can be spent on building your end user features.

We provide the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production. Request a demo here , join our Discord or reach out to us at support@vellum.ai if you have any questions!

‍
