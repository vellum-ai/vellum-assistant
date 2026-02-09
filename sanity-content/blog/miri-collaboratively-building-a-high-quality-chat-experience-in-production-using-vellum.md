---
title: "Miri: Collaboratively building a chatbot in production with Vellum"
slug: "miri-collaboratively-building-a-high-quality-chat-experience-in-production-using-vellum"
excerpt: "How Miri built a powerful chat experience using Vellum's platform"
metaDescription: "Learn how Miri built a powerful and custom llm chatbot for wellness coaching using Vellum's LLM platform. "
metaTitle: "Miri: Collaboratively building a chatbot in production with Vellum"
publishedAt: "2023-10-13T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your an AI chatbot to production today."
authors: ["Akash Sharma"]
category: "Customer Stories"
tags: ["Assistants"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/2bf10c9015b5695ef3faced19bc437e55ac946a5-1107x762.png"
---

Recent advances in Large Language Models have fueled incredible new chat experiences where end users can converse with AI. However, building a custom, production-grade, AI-powered chat experience is still fraught with challenges.

In this post, we break down how Miri, a company specializing in AI-powered wellness coaching, approached the problem and the successful solution they ended with (try out Miri and get your personal wellness companion for free here if you’re curious!)

## Who is Miri, and what brought them to Vellum?

Miri is an early-stage startup aiming to revolutionize the health and wellness industry. Miri allows people from around the world to get access to the top health experts at a much lower cost through a personalized ongoing coaching experience. Chat is a cornerstone of this AI coaching product and is built using LLMs to mimic the experience individuals get when they work directly with top experts; a deep understanding of their personal history, education on key topics, personalized recommendations for behavior change, and thoughtful check-ins.&nbsp;&nbsp;&nbsp;

When we first met the team at Miri, their first priority was to deeply integrate LLMs into their product. Before coming to Vellum, the team had built an internal proof of concept which was really powerful and showed the potential of LLMs for this use case but did not give them the flexibility they needed for production use. Popular open-source libraries weren’t cutting it for their use cases given their bespoke needs. Product Advisor Adam Daigian knew they wanted significant flexibility to tweak instructions given to the model (for better quality) and test different product experiences without having to iterate exclusively at the codebase level and through Colab/Jupyter notebooks. Time to market was of the essence and the cross-functional team needed a platform to collaboratively build and iterate on their LLM powered chat experience.

![](https://cdn.sanity.io/images/ghjnhoi4/production/1ecd8ae255d0571fcd27e850ed2e2fc78b2f78b2-1280x192.png)

## How Miri uses Vellum for their product development?

When the team at Miri was looking for a platform to build, they wanted a place to rapidly test, iterate, and deploy multiple prompts. They were looking to work closely with a team that understood their requirements and were willing to invest in product capabilities to support their development. The Vellum team provided architecture advice and prompt engineering best practices to quickly onboard the product and engineering team at Miri.

The LLM development process at Miri has been transformed in the last few months. Using LLMs in production is no longer a blackbox and new ideas/use cases can go into production within a week (with sufficient testing!). Engineering time is effectively leveraged and used primarily for final testing, integrations, and building a magical end user experience. While the Miri team started by trying to solve the initial LLM development problem, what they’ve really enjoyed about using Vellum is that it’s proving to scale with the team’s needs once the chat experience is in production too.

Since the LLM chatbot and underlying logic (how prompts, conditional logic, semantic search all tier together) are all built and deployed in Vellum, the team at Miri is able to quickly spot and diagnose edge cases in production. For a recent edge case they discovered in production, Adam was able to find the completion, look at the inputs &amp; outputs at each step, isolate the problem to a specific instruction in one prompt (which was part of a multi-step prompt chain), update the instruction and redeploy the chatbot with new instructions all in under 2 hours and without having to write a single line of code. The chatbot was then able to handle this edge case in production.

Miri is rapidly iterating on its production chat experience, identifying test cases based on user responses, and continuously improving the quality of their product thanks in part to Vellum’s platform. Actual data in production can easily be added as a test case for further iteration.

## What impact has this partnership had on Miri?

Vellum’s platform is an essential tool which helps Miri deliver a cutting edge consumer facing generative AI product. The fact that testing, iteration, and monitoring can happen in one place and everyone can collaborate in the development process is of enormous value to them. The collaboration is both asynchronous (independently working on the same prompt) and also synchronous (Vellum UI is shared on a screen during a call). The team at Miri is excited about multiplayer mode (a-la Google Docs &amp; Figma) for live prompt editing to come to Vellum’s product soon!

These days, Adam, as a product advisor, is able to build 60-70% of any new conversation flow himself; The team at Miri frequently shares feature requests which would improve their development processes and have seen Vellum’s product evolve to better suit their needs.

![](https://cdn.sanity.io/images/ghjnhoi4/production/ec485c1612edf0adbfbb62b0b6eeb959e987bdbd-1600x400.png)

‍

## Want to try for yourself?

‍ Miri has a public beta you can use for free today. Beta access available now for free ongoing wellness coaching, personalized for your unique health goals.

Dozens of companies like Miri have improved the quality of their LLM applications and internal development processes when working with Vellum. Vellum provides the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production — no custom code needed! Request a demo for our app here , join our Discord or reach out to us at support@vellum.ai if you have any questions. We’re excited to see what you and your team builds with Vellum next!

‍
