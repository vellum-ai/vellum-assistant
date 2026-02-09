---
title: "How Lavender cut latency by half for 90K monthly requests in production"
slug: "how-lavender-cut-latency-by-half-for-90k-monthly-requests-in-production"
excerpt: "Learn how Lavender develops and manages more than 20 LLM features in production."
metaDescription: "Learn how Lavender develops and manages more than 20 LLM features in production."
metaTitle: "How Lavender cut latency by half for 90K monthly requests in production"
publishedAt: "2024-02-13T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
imageAltText: "Cover photo showcasing a graph"
authors: ["Anita Kirkovska"]
category: "Customer Stories"
tags: ["Deployments"]
industryTag: "SaaS"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/f09c0e6e3b7699c169695bd38681ffab6d1aa8b4-1165x627.png"
testimonialAuthorName: "Sasha Boginsky"
testimonialAuthorTitle: "Applied AI Lead"
testimonialReview: "We've cut latency by 50% and reliably handle 90,000+ monthly production requests with Vellum. The flexibility of the platform and their first-class support transformed how we deliver real-time features without performance trade-offs."
---

Lavender AI combines the latest data, AI, psychology, and science to improve your sales emails.

Their AI features are seriously impressive, leaving you thinking, “How do they always get it right?”

At the heart of their approach is a commitment to careful prototyping and ongoing improvements of their prompts, informed by real user feedback.

Today they manage more than 20 LLM features, and over 90K monthly requests in production using Vellum.

If you want to learn how to manage lots of prompts in production, and continuously improve the quality of the output while keeping latency low, read on.

‍

Who is Lavender?

Lavender is an email intelligence company with an AI email coach. It’s the most effective tool for writing better sales emails faster.

Lavender empowers thousands of sellers globally to write emails that get replies, leading to increased efficiency, confidence, booked meetings, and pipeline.

‍

What Brought Them to Vellum?

Right from the beginning, the Lavender team understood the importance of having more effective tools for prototyping and managing their prompts in production. They also wanted to engage the whole team in this process. Yet, at that time, the task of iterating and evaluating prompts was restricted to the codebase, making it an activity exclusive to developers.

To solve for this, they initially used another AI development platform, but soon after migrated to Vellum, because they needed a more feature-rich environment. They were looking for a platform that could help with testing different real-world scenarios, manage many prompts in production, ensure model availability and access, and support collaboration.

We sat down with Sasha Boginsky , Lavender’s Full Stack Engineer, to learn more — here’s Lavender’s journey from a very rigid prompt engineering process, to a collaborative and enhanced one, where they move quickly and maintain high-quality prompts in production.

‍

How Does Lavender Use Vellum Today?

Today, Lavender uses Vellum to manage more than 20 LLM features in production, with a notable volume of 90,000 requests handled in January alone.

Their application of language models span various use cases, and Sasha has shared more details on how they prototype and improve their features using Vellum.

### Sentence transformers

Their Email Coach feature automatically reviews sales emails to pinpoint areas for improvement. It specifically flags sentences that could be better crafted. For example, if a sentence is too lengthy or complex, the coach will suggest ways to simplify or shorten it.

They currently manage more than 10 sentence prompts in production, and use Vellum’s prompt engineering environment for initial testing and evaluation. They’re also collecting end-user feedback and closing the feedback loop in Vellum using Vellum’s APIs . They then use that data to improve their prompts.

### LLM chains

Lavender's Personalization Assistant gives you customized news, insights, and intro tips for better outreach, using data points and insights they’ve collected over the years.

To set up the complex LLM chain of parsing this data and personalizing the output, they use Vellum’s Workflow product .

This process was very clunky when it was handled via code, and Sasha says that now it takes them a few minutes to set up and run a LLM chain in Vellum.

### Classification

Lavender is utilizing LLMs to extract new information from their data. For instance, their analytics dashboard now runs multiple classification prompts to provide new, important insights. These insights could be things like the best day of the week to send an email, whether your email comes across as pushy, the presence of humor, and other best practices.

‍

What Impact Has This Partnership Had on Lavender?

### Cut Latency in Half

The process has become significantly quicker, but even a bigger impact, however, is that they've managed to reduce their average latency by 50%.

Sasha shares that reducing latency was really important because the LLM outputs are shown in real time in the app. By using Vellum, they were able to integrate an Azure client and significantly cut their execution time.

This ended up being a huge performance lift for their users.

> “There is nothing we can’t accomplish, because we know that we can do it with Vellum and your team by our side!” ‍ - Sasha Boginsky, Lavender’s Full Stack Engineer

### Collaboration is easy

Sasha also remembers that the last time they collaborated on a prompt, it took the team 15 minutes to get to a better prompt.

Being able to have a tool that welcomes everyone on the team to prototype a prompt is something that helped them to ship and test a lot of ideas.

### Using live data to iterate on prompts

It’s so easy for Lavender to capture edge cases, because they collect all of their live completions in Vellum. Sasha shares that this is her favorite feature, because it’s so easy to capture bad examples, add them to scenarios in their Prompt sandbox, then optimize the prompt to account for that edge case.

### First-class support and expertise

Apart from this, the team really enjoyed the support that Vellum’s AI experts provided them. They felt assured not only by the platform itself but also by the expertise of the team, knowing they had support throughout their journey.

Now that they cut their latency cost in half, they’re looking to cut their costs, so the next step is to fine-tune a model using the completions data that they’ve been collecting as training data.

We are so excited to continue to partner with Lavender and provide them with the best AI product development platform for their team!

# Want to try out Vellum?

Vellum has enabled more than 100 companies to build multi-step AI apps faster, evaluate their prompts and ship production-grade AI apps.

If you're looking to incorporate LLM capabilities, optimize your LLM outputs and empower the whole team, we're here to help you.

Request a demo for our app here or reach out to us at support@vellum.ai if you have any questions.

We’re excited to see what you and your team builds with Vellum next!

## Table of Contents

About Lavender Problem Solutions Impact
