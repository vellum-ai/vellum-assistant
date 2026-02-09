---
title: "Synthetic Test Case Generation for LLM Evaluation"
slug: "synthetic-test-case-generation-for-llm-evaluation"
excerpt: "Easily test your AI workflows with Vellum—generate tons of test cases automatically and catch those tricky edge case"
metaDescription: "Easily test your AI workflows with Vellum—generate tons of test cases automatically and catch those tricky edge cases."
metaTitle: "Synthetic Test Case Generation for LLM Evaluation"
publishedAt: "2024-11-20T00:00:00.000Z"
readTime: "4min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Nico Finelli"]
category: "Guides"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/6030f19b2401e2c2f4d007e1e05fb66ae4a03904-1074x739.png"
---

Debugging AI workflows often feels like chasing shadows, especially when trying to verify that your LLM is giving the right answers in every possible scenario. At Vellum, we know this challenge all too well, and that’s why we’ve introduced a solution to simplify this process: synthetic test case generation .

Here’s the gist:

When you’re building AI systems, you need test cases that simulate real user interactions.

For instance, we created a chatbot designed to answer questions about our company’s security policies. A user might ask, “What encryption does Acme Company use for my OpenAI key?” The chatbot should respond with the correct details—say, "AES-256 encryption per our trust center policy."

But generating enough test cases to cover edge cases, obscure questions, and everything in between is time-consuming.

That’s where synthetic test case generation steps in.

# Synthetic test case generation in Vellum

To generate synthetic test cases in Vellum we can define an Evaluation suite and run a custom Workflow that we designed for this purpose. Here’s a walkthrough on how we were able to create synthetic test cases for our “Trust Cener” Q&amp;A bot:

# Generating a Test Case Suite

We first start by defining an Evaluation suite in Vellum. We added a metric (e.g., "Ragas - Faithfulness") by naming it, describing its purpose, and mapping the output variable (e.g., "completion") to the target variable:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ee5f9df683ce71aff3088e82a7b6fc66710ec34d-3453x1847.png)

Then, we created one Evaluation Suite example for the LLM to generate more from. In our case, we set up this starter Test Suite:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/cbe0c291057a24463cdc666a26392350c7a32fed-2450x922.png)

# Creating the Workflow Template

Next, we set out to build a Workflow that could automatically generate test cases for the Evaluation Suite we just configured.

To achieve this, we designed a multi-step Workflow that performs two key tasks:

Uses LLMs to generate test cases based on defined criteria Leverages our API endpoints to bulk upload the newly generated test cases into the specified Evaluation Suite

Here’s the final version of the workflow:

# Running the Workflow Template

To run the workflow we provided these three variables:

Workflow Purpose: We specify what our AI system does Test Suite Name: We add our Test Suite name that we generated. In this case we just type: trust-center-synthetic-generated-tests Number of test cases: We then add the number of test cases we want to generate

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b20976ed6c80a56fa00225f12e5ea882fc124575-1408x1298.png)

Then, once we ran the Workflow, the newly generated test cases were upserted directly into our Evaluation suite, ready to be tested against our custom metrics like Ragas faithfulness:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6f66ccc2a18d6f59fd66e6758b6c286e7d428ea2-2776x1556.png)

# Why It Matters

Manually writing test cases is painful and doesn’t scale. Synthetic test case generation saves time, ensures you test a wider range of user interactions and it can adapt as your AI workflows grow in complexity.

Our customers tell us this feature is a game-changer. You’re no longer stuck writing endless test cases by hand or worrying about missing critical scenarios.

Want to try it for yourself? Let us know—we’re here to help!
