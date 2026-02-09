---
title: "Vellum Product Update | December 2023"
slug: "vellum-product-update-december-2023"
excerpt: "December: fine-grained control over your prompt release process, powerful new APIs for executing Prompts, and more"
metaDescription: "December: fine-grained control over your prompt release process, powerful new APIs for executing Prompts, and more"
metaTitle: "Vellum Product Update | December 2023"
publishedAt: "2023-12-31T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Release Management of Prompts and Workflows New Execute Prompt APIs New Models Block Vellum Staff Access Workflow Deployment Monitoring Download Test Suite Test Cases as CSV Export Workflow Deployment Executions Quality of Life improvements

Release Management of Prompts and Workflows

Up until now, whenever you updated a Prompt or Workflow Deployment, the changes would go live immediately to your end-users. However, you might more precise release management so that you can decide via code when changes to a Prompt or Workflow go live in a given environment.

You can now achieve fine-grained release management via Release Tags! Release Tags are identifiers that you can pin to in your codebase to point to a specific version of a Prompt/Workflow. You can then increment this version in code, similar to how you might pin to a version of a node module or pip package.

You can watch a full demo of this feature here .

![](https://cdn.sanity.io/images/ghjnhoi4/production/29727b9d19f57c739735332673d7ad4993343807-3102x1934.png)

To further improve the process of releasing new versions of Prompts/Workflows, we also now display a warning if you’re about to change the input/output interface of the deployment that’s being updated.

![](https://cdn.sanity.io/images/ghjnhoi4/production/f8e734a5687e99eb13a85ba9df3add0a1cce0902-1804x1470.png)

‍

New Execute Prompt APIs

We launched two new production-grade APIs for invoking your prompts in Vellum - Execute Prompt and Execute Prompt Stream !

For a complete overview, read the official announcement .

Here's a quick summary of what these new APIs enable:

Improved interface that’s more consistent with Vellum’s other APIs Storing arbitrary JSON metadata alongside each execution Future-proofed by default (this is very useful as LLMs are releasing new features in their API’s) You can override anything about the API request that Vellum makes to the LLM provider at runtime You can specify the return of raw data that comes directly from the LLM provider’s response

Here's a look at the new Execute Prompt API:

![](https://cdn.sanity.io/images/ghjnhoi4/production/d69d7a655b4aba75459b043704333c8e88ba11ac-828x1216.png)

‍

New Models

Some really powerful models were launched in the month of December, and we’re really excited to share that you now have the option to use them in Vellum.

Here are the latest models added in Vellum, complete with links for more details on their performance and use-cases:

mixtral-8x7B-instruct [ more info ] mistral-7b-instruct [ more info ] capybara-34b [ more info ] yi-34b-200k [ more info ] yi-6b [ more info ]

‍

Block Vellum Staff Access

Vellum employees have been trained to handle customer data with the utmost care and have access to customer workspaces in order to help debug issues and provide support. However, those that work with especially sensitive data may want to limit this access.

You now have a new option to control the whether Vellum staff has to your workspace(s). Simply go to the Organization module, find Settings, and switch off "Allow Vellum Staff Access."

In situations where you need us to debug an issue, you can give us temporary access by turning the toggle on again.

![](https://cdn.sanity.io/images/ghjnhoi4/production/a0d71560f7ada52fb33c02356d70907bef46bc62-1050x874.png)

‍

Workflow Deployment Monitoring

Using Workflow Deployments, you can see the individual API requests made to a Workflow. This is great for seeing granular details, but not so great for visualizing trends in how your Workflow is performing.

You’ll now see a new “Monitoring” tab in Workflow Deployments which includes charts for visualizing data such as the number of requests, average latency, errors, and more.

If you want to see other charts in this view, please reach out to support@vellum.ai and let us know!

![](https://cdn.sanity.io/images/ghjnhoi4/production/03012223c75671083419ee89630192633fb02109-3456x1918.png)

‍

Download Test Suite Test Cases as CSV

As with many of our other tables, you can now download the Test Cases within a Test Suite as a CSV.

![](https://cdn.sanity.io/images/ghjnhoi4/production/c36c81f91a8269d753913ce08cb8e34b1c5b5dda-1670x698.png)

Also, we now display a column count indicator for that shows how the number of visible columns. Remember, only the visible columns are included in exported CVS so make sure to display any columns you want in the export.

![](https://cdn.sanity.io/images/ghjnhoi4/production/9352da11a02d593749baae60a80fcf5144f63fe4-1444x562.png)

‍

Export Workflow Deployment Executions

You can now download raw data about all API requests that were made against a Workflow Deployment.

This is useful if you want to perform your own bespoke analysis or use it as training data for a custom fine-tuned model.

![](https://cdn.sanity.io/images/ghjnhoi4/production/2f59e48e03af94f83bff6898bdfb90070e582682-3456x1918.png)

Quality of Life improvements

Here are a few honorable mentions that we snuck in too:

Invite Email Notifications: Now, when you invite someone to your organization, they'll receive an email letting them know. Links from Prompt Sandboxes to Deployments: You can navigate directly from a Prompt Sandbox to its Deployment using the “View Deployment” button in the top right corner Filtered Prompt Deployments: Under the hood, we auto-create one Prompt Deployment per Prompt Node in a Workflow. These would clog up the Prompt Deployments view within providing much value. Now, they’re filtered out so you only see the Prompts that you explicitly deployed.

# Looking Ahead

We have grand plans for the new year and can’t wait to share more of what we’re working on. Thanks so much to our customers who have helped us get to this point! 2024 is going to be even more exciting 😀
