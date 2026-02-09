---
title: "Redfin's Test Driven Development Approach to Building an AI Virtual Assistant"
slug: "redfins-test-driven-development-approach-to-building-an-ai-virtual-assistant"
excerpt: "Discover how Redfin used Vellum to develop and evaluate a production-ready AI assistant, now live in 14 markets."
metaDescription: "Discover how Redfin used Vellum to develop and evaluate a production-ready AI assistant, now live in 14 markets."
metaTitle: "Redfin's Test Driven Development Approach to Building an AI Virtual Assistant"
publishedAt: "2024-04-09T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build Your AI Virtual Assistant Today"
authors: ["Anita Kirkovska"]
category: "Customer Stories"
tags: ["Evaluation", "Prompt Engineering", "Deployments"]
industryTag: "Real Estate"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/af21865ee73cfed49e4c0888082fec0cd8009ff1-1120x640.png"
testimonialAuthorName: "Sebastian Lozano"
testimonialAuthorTitle: "Senior Product Manager"
testimonialReview: "Using Vellum to test our initial ideas about prompt design and model configuration was a game-changer. It saved us hundreds of hours."
---

On March 7, Redfin announced the beta launch of Ask Redfin , an AI-powered virtual assistant that provides quick answers to homebuyers' questions about properties for sale. With Ask Redfin, house hunters can easily obtain information about listings, such as upcoming open houses, monthly HOA fees, school districts, and more.

To build this conversational system, Redfin adopted a test-driven development approach to set a high bar for Ask Redfin’s ability to answer questions accurately and fairly.

With this objective in mind, they used Vellum to experiment with and evaluate different prompts and workflows across a wide array of test cases before deploying their virtual assistant into production.

For those interested in creating a production-ready AI chatbot using a test-driven development approach, keep reading to learn more.

‍

Who is Redfin?

Redfin ( www.redfin.com ) is a technology-powered real estate company. They help people find a place to live with brokerage, rentals, lending, title insurance, and renovations services. They run the country's #1 real estate brokerage site. Their customers can save thousands in fees while working with a top agent.

Their home-buying customers see homes first with on-demand tours, and their lending and title services help them close quickly. Customers selling a home can have their renovations crew fix it up to sell for top dollar. Their rentals business empowers millions nationwide to find apartments and houses for rent. Since launching in 2006, they’ve saved customers more than $1.6 billion in commissions.

They serve more than 100 markets across the U.S. and Canada and employ over 4,000 people.

‍

Why Did Redfin Choose Vellum?

Redfin’s team knew that linking to a model API and integrating unique data can create a solid proof of concept (POC), but developing a production-ready AI virtual assistant requires much more.

It involves understanding user intents, devising strategies for various responses, evaluating every step of the workflow, and selecting an optimal model and prompt combination for accurate and relevant responses.

## Test-Driven AI Virtual Assistant Development

Redfin was on the hunt for an AI development platform that could help them facilitate a test-driven development approach to developing a reliable conversational system. They wanted to iteratively test their logic, and achieve the highest precision possible when dealing with a variety of customer questions — all while trying to be particularly thoughtful about fair housing.

Vellum 's ‍ products were the perfect fit for Redfin's requirements. By integrating with Vellum, Redfin’s product and engineering teams were able to collaborate far more effectively and quickly scaled out the building and testing of their chatbot logic.

We sat down with Sebi Lozano, Redfin’s Senior Product Manager, to learn more — here’s Redfin’s journey from a simple concept to a fully implemented, cutting-edge AI virtual assistant that enhances the home-buying experience for users nationwide.

‍

How does Redfin use Vellum today?

## Collaborate on Prompts

Redfin used Vellum’s prompt engineering environment to pick the right prompt/model for a given task. They iteratively tested prompts to evaluate Ask Redfin’s ability to answer questions correctly.

Prompt Engineering is a core part of any LLM application &amp; Vellum’s tooling made it much faster to create good prompts.

###### 📹 Here’s a quick demo on how “ Prompts ” work.

## Build Complex AI Virtual Assistant Logic

Given Redfin’s scale, they cared deeply about minimizing cost and latency without sacrificing quality. To accomplish this, they had to break down conversational flows into several nodes. They used “ Vellum Workflows ” to connect the prompts, classifiers, external APIs and the data manipulation steps into one multi-step AI workflow.

In the Workflow builder, they were able to connect all this logic by using customizable nodes that can handle various data, tools and LLM tasks.

Their product team was able to independently test changes, make tweaks to prompts, and even try out entirely new chains and then collaborate with engineering to productionize the best of the best.

###### 📹 Here’s a quick demo on how “ Workflows” work.

## Systematically Evaluate Prompts Pre-Production

Generative AI chatbot development, aka prompt engineering, is extremely iterative. When you make one change to a prompt, you want to make sure that it’s had the effect you expected and that it didn’t create a regression in another part of the system.

To navigate this complexity, Redfin used “Vellum Evaluations ”, which allowed them to rigorously test each prompt/model combination. They used hundreds of test cases to evaluate how well the virtual assistant was answering questions.

This approach enabled them to evaluate all LLM outputs in their virtual assistant logic, across multiple intent and action combinations, to ensure they met their quality threshold.

###### 💡 Learn more about “Vellum Evaluations” on this link.

Learn from Redfin's journey in this recent webinar where we covered how Redfin evaluated their virtual assistant before they sipped it nationwide:

‍

What impact has this partnership had on Redfin?

By using Vellum’s technology, Redfin was able to follow a test-driven approach to developing Ask Redfin which gave them the confidence to launch the virtual assistant as a Beta in 14 markets across the U.S.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ec72aa4888aae0f6e7dcaa5c2d78dd3a49da45e0-1536x1536.jpg)

Sebi, Senior Product Manager at Redfin, says that to enable test-driven development, it’s crucial to separate prototyping from coding to speed up the team's workflow.

> Using Vellum for testing our initial ideas about prompt design and model configuration was a game-changer. It allowed us to work without always needing engineering resources, enabling a broader group of people to work on prompts and to work faster without needing to deploy code to test changes. Once we had satisfying results from the prototyping phase, we then handed over the process to our engineers to integrate it into our production system. Vellum’s software, and their knowledgeable team, saved us hundreds of hours. - Sebi Lozano, Senior Product Manager at Redfin

Apart from this, Sebi shares that it was really easy for Redfin’s team to:

Evaluate which models will get the best value for the lowest cost: It was fairly easy for the whole team to evaluate different models and evaluate various prompts. By analyzing performance and price, they can make better tradeoffs between models, and can project the expenses for when real users begin using the chatbot. Evaluate intent handlers at scale: Not only were they able to evaluate their prompt combinations, they also got confidence about the quality of the responses due to large scale testing using the “ Evaluations ” product. They were able to test their prompts with known and tricky scenarios, but also with new variations that were synthetically generated using another LLM call. Learn best practices: Redfin collaborated weekly with the Vellum’s in-house AI experts to tackle prompt hallucinations, learn the latest prompting techniques, and unblock any other problems they faced during the process.

Our collaboration with Redfin demonstrates how a test-driven approach, supported by the right tools, can accelerate the development of an AI-powered virtual assistant.

‍

Observations and Learnings

For those interested in building a production-ready AI virtual assistant, the journey of Ask Redfin serves as an insightful guide. It underscores the value of a methodical approach to AI development, where continuous testing and refinement play critical roles in achieving a successful outcome.

## Prompt Engineering Tips

Sebi also shares some prompt engineering tricks that helped them in their development process:

Be extremely explicit about how you want the LLM to evaluate an answer. Thinking of an LLM as an “intern” resonated with us. Repeating phrases helped the LLM perform as expected (i.e. “be extremely strict”, “remember…” Chain of Thought reasoning (asking the LLM to write out its reasoning) made our classifiers more accurate and made it easier to debug issues.

You can read more about the Chain of Thought technique here , or find more prompt engineering tips in this guide.

## Using Vellum

By using Vellum , Redfin was able to simulate various user interactions, test different prompts and their effectiveness across numerous scenarios.

You can find more details on how to evaluate your RAG system in our latest guide here .

‍

Want to Try Out Vellum?

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/12c2d38fce3173cb29a2ef34de538c4a9680188a-2249x1416.png)

Vellum has enabled more than 100 companies to build complex AI chatbot logic, evaluate their infra and ship production-grade apps. If you’re looking to develop a reliable AI assistant, we’re here to help you.

Request a demo for our app here or reach out to us at support@vellum.ai if you have any questions.

We’re excited to see what you and your team builds with Vellum next!

## Table of Contents

About Redfin Why Vellum? How does Redfin use Vellum today? What impact has this partnership had on Redfin? Observations and Learnings Try Vellum
