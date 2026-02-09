---
title: "How Woflow Decoupled AI Updates for 50% Faster Delivery — Without the Infra Stress"
slug: "how-woflow-decoupled-ai-updates-and-simplified-data-extraction-with-vellum"
excerpt: "Learn how Woflow sped up AI development by 50% — making it easier to handle errors, improve models and ship updates."
metaDescription: "Learn how Woflow sped up AI development by 50% — making it easier to handle errors, improve models and ship updates."
metaTitle: "How Woflow Decoupled AI Updates for 50% Faster Delivery — Without the Infra Stress"
publishedAt: "2024-09-10T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build a production-ready AI app with Vellum"
authors: ["Anita Kirkovska"]
category: "Customer Stories"
industryTag: "Food & Beverage"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/7fba461314c1a79d76cf2520de88a79781ef4b87-1165x627.png"
---

Picture this: You're craving your favorite burger, so you open a food delivery app. In seconds, you're scrolling through a mouthwatering menu.

Sounds simple, right?

But behind that seamless experience lies a mountain of data – every ingredient, every price, every option needs to be just right.

Now multiply that by millions of restaurants, stores, and service providers across the country.

That's the challenge Woflow set out to tackle.

Industry giants like Walmart, DoorDash, and POS companies like Square who onboard tens of thousands to millions of customers trust Woflow to automate their merchant onboarding processes.

Woflow’s smart AI system works with millions of lines of unstructured data to digitalize catalogs and update any merchant data in seconds. But as Woflow grew, their AI development processes became complex, so the team had to figure out:

How to continuously update AI features on the fly without waiting for scheduled releases? How to test AI models rapidly to improve the AI system? How to build fault-tolerant system and capture errors on time?

Woflow wanted to make their AI system more modular and capable of handling more complex tasks — &nbsp;while still giving customers the best possible experience.

To achieve this, they turned to Vellum. This strategic move allowed Woflow to experiment and assess the quality of their LLMs 50% faster than before, dramatically accelerating their time-to-production.

We spoke with Michael Liu , Data Scientist, and Jordan Nemrow , CTO of Woflow to hear their story. What follows is a behind-the-scenes look at how they continuously update their AI systems to onboard millions of merchants online — and get you that burger with just one tap.

🚨 Quick announcement: Woflow will be sharing their journey and insights from their AI development process in our next webinar. Read more here.

‍

Smarter AI, Fewer Lines of Code

As Woflow’s AI system grew, the code was becoming more complex to manage and improve. They wanted to execute their LLM features in code — but abstract the functionality in a separate and more maneagable system.

The team had initially turned to open-source libraries as a potential solution, hoping to find a common ground among the various AI providers. However, this approach came with its own set of problems. "These libraries seemed like a lifeline at first," Michael recalls. "But we quickly realized that many of them were poorly maintained.”

"We needed a way to keep things simple," Jordan explains. "Something that would let us focus on making our AI better, not just keeping it running."

Enter, Vellum.

By using Vellum Workflows , the Woflow team was able to offload a big chunk of the AI infra, and replace it with a more digestible, user-friendly interface. Today, Woflow uses Vellum Workflows to build and maintain all of their AI features in one central place.

“Vellum is like our vessel for all the AI code we write — &nbsp;it allows us to intuitively route logic based on inputs and outputs. This makes organizing our code so much easier” adds Jordan.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6bd09f20cb4874602bbd17e4a19bbaad10fc7b19-3414x1702.png)

They’re big fans of the modular functionality that Vellum’s Workflows offer, allowing them to easily build and reuse any AI workflow — &nbsp;while maintaining team-wide standards for reusability.

“It’s also very useful that while Vellum provides a visual interface, it’s code-optional—you can do work with complex code if you want, but it’s also very simple if you don’t.” — adds Michael.

Using the Map Node for parallel execution, they’ve significantly increased the speed and efficiency of their system. Plus, they no longer need to write boilerplate code to handle basic operations. “We can focus on building features rather than managing repetitive tasks,” says Michael.

Michael adds, “The 1-day turnaround support for new model provider features, like structured outputs , has been a huge advantage for us. It makes incorporating the latest techniques incredibly easy!”

‍

Faster AI Updates with Diagrams and Decoupled Deployments

Bringing their AI code in Vellum brought two benefits for the team. They can now work more intuitively on improving their AI features and update them in production more quickly.

### Faster Code Iterations with Diagrams

As the CTO, Jordan explains: "We’ve always felt that diagrams are just more natural for this kind of work compared to code. With Vellum’s visual graph, it’s so much easier to follow the logic, spot issues, and improve AI features. You can see everything at a glance, which is a huge advantage over digging through lines of code."

They also say that it’s been very easy for new developers to learn how their workflows work, and are able to onboard much faster. In the future, they want their whole operations team to be able to tweak these prompts so they can respond to customers more quickly. “They’re the ones that get feedback from customers — imagine how much faster we can go if they can tweak a prompt and ship it in minutes” — says Jordan.

### Decoupled deployments

A major benefit for Michael and Jordan is the ability to update their AI features more frequently in production without redeploying the entire system

"Using Vellum, we can now update our AI up to 20 times a week without re-deploying our main application, " Michael states. This decoupling of AI updates from the core system allowed for rapid iterations and improvements — without messing up the rest of our app.

Jordan, also adds: "Previously, AI improvements were bottlenecked by scheduled application deployments. Now, we can implement changes immediately as needed.”

‍

Development is 50% faster with zero infra stress

Today, Woflow offloads their AI code to Vellum and no longer worries about infrastructure uptime and costs. Instead, they focus on building high-performing AI features.

The result?

They’ve sped up every aspect of their AI development process by 50%, from fixes and improvements to new features.

### Errors and unexpected behavior are fixed instantly

The team heavily relies on the ‘Workflow Execution Pages’ created by Vellum for each production execution. These pages allow them to review all workflow execution points and quickly pinpoint where and how errors occurred.

As Michael says “It’s so easy to capture a production execution and evaluate it against the whole system to analyze why it didn’t perform well. It’s just ridiculously easy and fast.”

### Everyone is able to move faster

More of their team is now involved in AI development, allowing everyone to build and ship AI workflows faster. Their vision is for the entire operations team to be able to update prompts and create tailored AI workflows for each customer.

“This changed the game for us. We’ll be able to move so much faster, and provide hands-on support to every customer we have” - says Jordan.

### AI updates no longer delayed by app deployments

Updating AI features in production is no longer delayed by major app deployments.

As soon as there’s feedback or a need for a fix, the team can deploy updates immediately without being held back by scheduled app releases.

‍

Offload your AI infra to Vellum

Woflow’s experience with Vellum demonstrates how the right infrastructure can lead to more organized and faster development. But this isn’t just Woflow’s success story—it could be yours too.

If you’re struggling with complex AI workflows or slow updates, Vellum is here to help. We know every company faces unique AI challenges, and we want to understand yours.

Let’s schedule a quick demo to show you how Vellum can streamline your AI development and scale your processes efficiently.

## Table of Contents

Why Vellum? Diagrams and Decoupled Deployments Faster AI Development Learn about Vellum
