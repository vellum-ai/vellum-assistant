---
title: "Announcing Vellum"
slug: "announcing-vellum"
excerpt: "We’re excited to publicly announce the start of our new adventure: Vellum"
metaDescription: "We’re excited to publicly announce the start of our new adventure: Vellum: development platform for LLM apps"
metaTitle: "Announcing Vellum: An AI development platform"
publishedAt: "2023-02-02T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today"
authors: ["Akash Sharma"]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/2bf10c9015b5695ef3faced19bc437e55ac946a5-1107x762.png"
---

Hi everyone 👋 ‍ We’re excited to publicly announce the start of our new adventure: Vellum. We’re in Y Combinator’s current batch (W23) and our mission is to help companies get the best results from Large Language Models like GPT-3. Our product helps developers evaluate, manage and A/B test AI models/prompts to increase quality and reduce cost.

## What problems are we trying to solve?

Since GPT-3 launched in 2020 we saw companies like Jasper and find compelling sales &amp; marketing use cases. In the last 2 years the rate of improvement of these foundation models has been staggering, as clearly evidenced by OpenAI’s ChatGPT and models from Cohere and AI21.

With all these advances, companies around the world are looking to incorporate Large Language Models (LLMs) for generation and classification use cases both for internal applications and in their core product. However, we’ve seen 3 challenges when companies try to bring these models into production. These obstacles result in slower iteration cycles and suboptimal configurations of these Large Language Models.

‍

Initial setup and deployment is difficult Monitoring and other best practices require engineering teams to write lots of custom code Ongoing model optimization and evaluation is time consuming and requires deep technical knowledge

### Going from 0 -&gt; 1

When coming up with initial prompts, we’ve seen firsthand the challenges developers face when choosing between model providers 1 , foundation models 2 , and model parameters 3 . Several browser tabs are needed to perform experiments and results are stored in long spreadsheets for side-by-side comparison. There’s no good way to collaborate with colleagues while iterating on prompts.

Choosing the right prompts often comes down to a time-boxed guessing game and you are never sure if a better outcome is possible – forget about spending the time to try fine-tuning!

### Managing Once in Production

Once the right prompt/model is deployed, a lot of internal custom code is needed to track model/prompt version history and an audit log of model inputs, outputs and ground truth results from the end user. Setting up this infrastructure is important to measure performance, experiment with new prompts, and revert to older model versions if the changes are not ideal. These LLMs are so sensitive that a single word change in your prompt could provide dramatically different results. Because of this, most developers are reluctant to iterate and try to improve the model in fear that it’ll break existing behavior.

The time spent building and maintaining monitoring and testing infrastructure is non-trivial and could instead go towards building your core product.

### Optimizing to Get the Very Best

Once models have been running in production and the right tooling is set up, there's usually data available to fine-tune the models to provide better quality at a lower cost. However, setting up the right fine tuned model in production has its own challenges: getting training data in the right format, trial and error for different hyper parameter combinations, and retraining as new training data is collected.

To add to the complexity, this problem is only expected to increase over time as there are new model providers and foundation models, each with their own cost and quality tradeoffs. To keep up with the cutting edge, you have to constantly spend time evaluating new models as they’re released.

## Why we chose this problem

We worked together at Dover (YC S19) for 2+ years where we built production use-cases of LLMs (both generation and classification). Noa and Sidd are MIT engineers who have worked DataRobot’s MLOps team and Quora’s ML Platform team respectively.

We realized that all the ops tooling we had built for traditional ML didn’t exist for LLMs. We’d build these reasonable production use-cases of AI only to then be hesitant in making changes and improving our setup due to a lack of observability. We ended up having to build custom internal tooling to solve for this.

We’ve come to deeply feel the pains and requirements of using LLMs in production, user-facing application. We’ve decided to productize our learnings and share them with other companies so more people can make use of Generative AI without having to overcome the steep learning curve we went through.

## What's next for Vellum

We’re at the beginning of an exciting journey and will be releasing several products and sharing best practices on how to work with LLMs. Stay tuned for updates on our blog!

- Akash, Sidd &amp; Noa ‍

1 Model provider examples: OpenAI, Cohere, AI21 2 Foundation model examples: GPT-3’s Ada, Babbage, Curie and Davinci 3 Parameter examples: Temperature, Top-P

‍
