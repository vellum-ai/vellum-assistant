---
title: "Running Arbitrary Code in Workflows & Evals"
slug: "running-arbitrary-code-in-workflows-evals"
excerpt: "Write and execute Python or TypeScript directly in your workflow"
metaDescription: "Write and execute Python or TypeScript directly in your workflow"
metaTitle: "Running Arbitrary Code in Workflows & Evals"
publishedAt: "2024-11-13T00:00:00.000Z"
readTime: "3 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/3c0fa55803c22c3ae74032ebe9e1a2d0a5579c65-716x493.png"
---

We know that AI development isn’t a rigid, one-size-fits-all process; it’s highly iterative, with needs that can change from project to project.

This flexibility is especially critical as AI tech evolves and new data sources, orchestration techniques, and business requirements emerge. With Vellum, our goal is to give engineering and product teams the tools to adapt quickly, ensuring that your orchestration setup can grow with your needs.

While our out-of-the-box nodes like RAG, Map node, model connectors, guardrails, error nodes (and 10 other Nodes!) are designed to cover common needs, we recognize that real-world AI applications often demand more. You might need to bring in a unique data feed, build out a specialized evaluation metric, or apply complex, project-specific logic that goes beyond standard integrations.

That’s why we built custom code execution nodes into Vellum’s platform. With these nodes, you can write and execute Python or TypeScript directly in your workflow, extending your build beyond pre-set functions while staying within Vellum’s visual builder.

Here’s a closer look at what makes this feature so versatile.

# Arbitrary Code Execution in Workflows

Imagine this: You’re setting up a workflow to give users up-to-date weather info.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3dc8772ba5ddf6358859f994124fb6f7c7551e27-1428x788.png)

You’ve got the basic workflow configured in Vellum, but you need it to call APIs, like Google Maps for coordinates and OpenWeather for the forecast, then return formatted data to your users. Out of the box, that’s complicated to manage without custom code.

With Vellum’s code execution nodes, you’re now able to write custom code in Python and TypeScript and build and test this functionality in our in-browser IDE.

Here’s what else you can do:

## Importing Third-Party Packages

With support for any public package from PyPI and npm, you’re not restricted to standard library functions. Import packages like requests for HTTP requests or googlemaps for location data, and integrate them seamlessly into your workflow.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/c08c5157b77892217da690da5f70e58e6ca5f7cd-1151x762.png)

## Securely Referencing Secrets

Vellum provides a secure secret store, allowing you to reference secrets in your code (e.g. API credentials) without inlining their literal values. Find more details on this link on how to set up and use secrets in Vellum.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/25ae68ab7272347d73d7ae27f908cd66ad50294b-1151x762.png)

## In-Browser Testing and Debugging

Test your custom logic on the spot.

With Vellum’s in-browser IDE, you can write, test, and debug code within the platform—no need for a separate environment or complex deployment process. Test runs show output logs immediately, so you can troubleshoot quickly and confidently.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7cff4c9b32b50fabc776a84f45b0d31e9908252e-720x540.gif)

Vellum’s code execution also extends to evaluation metrics, where you can write arbitrary code to create custom metrics to evaluate model responses.

# Building reusable eval metrics

Let’s say that you want to create an eval metric that measures the percentage difference between two JSON objects by comparing their structure and content. You can use the deepdiff package, a couple of inputs, and this Python code:

‍

Once you add all this info, here’s what the Code Execution Node for this metric will look like:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b636b5658a7c8cd73fa6d8ee8c0dbb750e168e93-1202x788.png)

This is ideal for teams focused on ML and AI who need consistent evaluation standards.

Imagine writing dozens of script like these — then centralizing them as “blessed” standards your team can reuse across different workflows, ensuring consistency and saving time.

# How to Get Started

To start using Code Execution Nodes in your Workflows, simply select the Node in your Workflow builder, and start defining and testing your arbitrary code:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/618b788e5f0c585b777bae043ae95121be6fd50a-1103x744.png)

Start by scripting out the logic, import necessary packages, and reference any secrets securely. Testing is simple, with in-browser testing allowing you to confirm the output in real-time. From there, you’re set to deploy within workflows or evaluations, ensuring smooth, consistent performance. The best place to start is to check our docs on code execution examples .

If you want to define a custom metric using the Code Execution Node, you can follow the tutorial outlined on this link .

# Try Vellum Workflows today

With Vellum’s code execution nodes, you gain the freedom to build workflows your way —whether that’s connecting to external APIs, integrating complex business logic, or defining custom evaluation metrics.

If your team wants to try out Vellum’s custom code execution and our visual builder, now’s the perfect time to explore how this flexibility can support your projects. Contact us on this link and we’ll have one of our AI experts help you setup your project.
