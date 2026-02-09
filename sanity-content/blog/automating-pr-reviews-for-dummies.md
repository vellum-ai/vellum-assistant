---
title: "Automating PR Reviews for Dummies"
slug: "automating-pr-reviews-for-dummies"
excerpt: "Time to see if I’ve automated myself out of a job."
metaDescription: "Time to see if I’ve automated myself out of a job."
metaTitle: "Automating PR Reviews for Dummies"
publishedAt: "2025-03-19T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Pei Li"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/e3cbb1b012e43636a62d2cb08cc042d94ea6cd90-1074x739.png"
---

PR reviews are an important part of an engineering organization. It’s a way to ensure quality, standardize coding practices, and share knowledge.

On average, Vellum’s 15 engineers open 50+ PRs per day. If each code review took 5 minutes, I would be spending 4 hours each day on only code reviews.

It’s not realistic, and definitely not fun.

You know what would be fun, though? Creating a bot that will review all my PRs for me - using just Github and Vellum.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/b78f25e1df935ce120160e7ea137ed1c9a8cbb4d-1636x402.png)

# Breaking It Down

High level, these are the steps I need to implement for a fully automated review bot:

Trigger actions whenever a pull request is opened Retrieve the PR, associated diffs, and coding guidelines Use an LLM to generate a review based on the diff and relevant coding guidelines Post a comment with the review on the PR

Step 1 can be done using Github Actions, steps 2 and 4 can be done using the Github API, and step 3 can be done using a good prompt. These steps can be orchestrated using Vellum Workflows.

# The Prompt

The biggest unknown is #3 - whether or not I can create a good review based on the diff and coding guidelines. I don’t want to distract or mislead our engineers with bad suggestions, and so quality is the highest priority here.

I went with GPT-4.5 for its quality, even though it’s more expensive than cheaper options such as GPT-4o Mini or GPT-4 Turbo. We can always reduce costs later by using a cheaper model, but first we have to prove that automated reviews can work. Here is the prompt I used on the first attempt:

> You are a code reviewer. You will be given guidelines for reviewing code in markdown format, and a code diff in git diff format. You should output clear and concise feedback that summarize high-level guideline violations at the start. Then output detailed feedback per guideline violation, citing the original code from the diff. You MUST correctly cite the code from the diff if you call out a violation. Don't be a nit. If it's a very minor violation, a brief callout is better than a long explanation, but you must still cite the code that caused the violation.

The output was surprisingly already great, with no further iterations and no examples. I won’t spoil the fun just yet, though - keep reading to see the final results.

## The Workflow

To implement steps 2-4, I’ll use Vellum Workflows. Using a combination of Template Nodes, API Nodes, and Prompt Nodes, I can make a standalone agent that reviews any PR if it’s given the PR number as input.

Here are the high-level steps:

1. Get the PR diff using

2. Execute the prompt using a Prompt Node and pass in the diff and our coding guidelines.

3. Apply formatting on the code review output using a Template Node.

4. Make a comment on the PR using

‍

Click to Interact

×

At this point, I can immediately test the Workflow by passing in an example PR number. If the Workflow passes testing, I can deploy the Workflow on Vellum, which allows it to be executed via API.

# The Integration

The only thing left to do is to hook up the Workflow Deployment to Github. I can do this using a Github Action:

Time to see if I’ve automated myself out of a job.

# Pei the Code Cop

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/bd22b331c88c7b46343d8f8e3c8bb5692df5e587-1824x3049.jpg)

These suggestions are right on the money! 🚢

# The Aftermath

In less than 4 hours, I’ve created a bot that produces high-quality reviews on 50+ PRs a day. While there is still room for improvement, this is already providing immediate value to our engineers by catching issues minutes after their PR is opened.

Some potential improvements we could make using Vellum:

Use good and bad examples in our prompt to help it make better reviews Use Vellum’s Actuals API to collect feedback on quality Break down the Workflow into simpler steps to allow cheaper models to be used

All of these improvements can be done using only Vellum. If you want to use this bot for your own engineering organization, book a demo with us here.
