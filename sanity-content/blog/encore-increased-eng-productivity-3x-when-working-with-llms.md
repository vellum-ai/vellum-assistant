---
title: "Encore increased eng productivity 3x when working with LLMs"
slug: "encore-increased-eng-productivity-3x-when-working-with-llms"
excerpt: "If you’re versioning in Jupyter notebooks or Google Docs, running custom scripts for testing, you need to read this"
metaDescription: "If you’re versioning in Jupyter notebooks or Google Docs, running custom scripts for testing prompts, you need to read this."
metaTitle: "Encore increased eng productivity 3x when working with LLMs"
publishedAt: "2023-07-06T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Akash Sharma"]
category: "Customer Stories"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/f159cac45b259fe3626e87425d54c8c0557647f3-1107x762.png"
---

If you’re version controlling prompts in Jupyter notebooks or Google Docs, running custom scripts for testing and wish you had more time, you need to read this.

### The challenge

Encore is an interactive music app whose mission is to empower artists to make a living from their music. Generative AI plays a key role in their product, here are some example use cases:

Song lyrics to album cover art

Start with song lyrics Run them through text summarization and idea generation prompts Run through another LLM prompt to create image prompts Send image prompt to Stable Diffusion to create cover art for the album

Generative AR with voice control

Build custom, immersive AR worlds on iOS devices Use LLMs to enable voice control and integrate multiple txt2image generators Integrate with lyric prompts to enable complete AR scene generation

There are several more AI use cases that Encore has which makes their product so exciting. Artists using Encore thoroughly enjoy these features but building and iterating on these prompts was extremely time consuming for the engineering team. The workflow was incredibly manual, spread across Google Docs, Colab notebooks &amp; Github. Given limited engineering capacity (story of all startups!), Encore’s CEO Jon Gray had to be the primary person responsible for building, iterating and testing these long prompt chains.

LLM prompt development was bottlenecked on Jon and the team couldn’t iterate fast enough. Status quo was untenable and Encore needed to find a solution. After searching online, Jon signed up for a demo with Vellum.

‍

![](https://cdn.sanity.io/images/ghjnhoi4/production/e8353276125091ca525ccce94dfc6ecaa39c5f6b-1986x366.png)

![](https://cdn.sanity.io/images/ghjnhoi4/production/dec2f1a580e759b1987793133c109cf9c4f9d50f-1618x1286.png)

‍

## The solution

After seeing an initial demo, Jon was hooked by how quickly both him and his team would be able to iterate on prompts both while testing before production and changing them once in production.

Jon onboarded the team at Encore to Vellum and within a couple days the non-engineering team members were able to contribute significantly to the prompt testing and experimenting process. Multiple team members at Encore would immediately start using Vellum’s Playground, which Jon called the “killer feature” of Vellum’s platform.

When coming up with a new prompt, the team at Encore now start with a new sandbox, build a little 3x3 grid and start iterating. They find it a very easy, simple and a powerful workflow to iterate on prompts. The team can collaborate on prompts, compare between model providers and run them across many test cases all without writing a single line of code.

Once the prompts are ready for production, Encore’s engineering resources are just needed to make small integrations with Vellum’s endpoints. Anyone can go in and see the completions being made and change the prompts in production without having to involve engineering. The regression testing feature helps them ensure that no existing behavior is broken while working changing the prompt.

‍

![](https://cdn.sanity.io/images/ghjnhoi4/production/c4c2425ba372e1d7f9630e8beb49ec3fcf0d0a52-1990x354.png)

![](https://cdn.sanity.io/images/ghjnhoi4/production/cfec73b3da8a25b79f9321e55526a710a131af9c-1858x1382.png)

### What’s next!

Encore has been a great partner and helped push Vellum’s platform forward. For instance, they’ve requested roles and permissions to limit what users can do in Vellum. They wanted some users to only edit prompts but not deploy them. Since the Role Based Access Control features were shipped, Encore has enjoyed using the platform even more.

Prompt chaining has been a common request for Encore and we at Vellum have worked closely with them to build out how that might work in the platform. We’re thrilled to have Encore as partners in the journey.

### Want to try out for yourself?

Vellum has helped dozens of companies improve their internal AI development processes. Sign up here to start exploring the platform for yourself. You will also schedule an onboarding call with one of Vellum’s founders who can provide tailored advice for your use case. We’re excited to see what you and your team builds with Vellum next!
