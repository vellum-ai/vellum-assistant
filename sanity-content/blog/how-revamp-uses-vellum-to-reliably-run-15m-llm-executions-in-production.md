---
title: "How Revamp Reliably Runs 15M+ LLM Executions in Production"
slug: "how-revamp-uses-vellum-to-reliably-run-15m-llm-executions-in-production"
excerpt: "Learn how to optimize prompt versioning, debug efficiently, and make real-time updates to boost AI performance."
metaDescription: "Learn how to optimize prompt versioning, debug efficiently, and make real-time updates to boost AI performance."
metaTitle: "How Revamp Reliably Runs 15M+ LLM Executions in Production"
publishedAt: "2025-02-10T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Customer Stories"
tags: ["LLM model"]
industryTag: "e-Commerce"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/358d76e946ba18373f35136a4fd6a1739ed5f187-1120x640.png"
---

Picture this: You’re browsing your favorite online store, add a few items to your cart, but for some reason, you don’t check out. Hours later, you get a reminder email. It’s bland, impersonal, and easy to ignore.

Now imagine that email speaks directly to you: mentioning the exact items you left behind, offering a tailored discount, or suggesting complementary products. It’s engaging, feels personal, and you’re far more likely to act on it.

This is the power of Revamp — a YC-backed startup that’s using AI to help eCommerce brands send hyper-personalized messages to their customers.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/e62b7c721e597d31c3d18e4334cf8da70490d2a7-1496x891.png)

With AI, they can do this at scale, without losing an ounce of quality.

But as Revamp grew, their AI development processes became more demanding, so the team had to figure out:

How can they quickly catch issues and update prompts at scale? How can they version prompts and avoid regressions without the eng overhead? How can they speed up AI development while handling millions of executions in production?

‍

These challenges could have easily slowed them down, but they found a solution in Vellum.

With Vellum , Revamp uses a first-class prompt versioning system to manage and evaluate 15 million LLM executions every month — and improve their performance.

We caught up with Xinchi Qi , one of the founders of Revamp, to hear their story. What follows is a behind-the-scenes look at how they continuously update their AI prompts &amp; fine-tune their models to make that next promotional email just a little less boring.

# Ditching the Vibe Check

Thinking your prompt works without actually testing it is a recipe for failure.

Revamp knew they needed a continuous feedback loop between their prototypes, production prompts, and the real-world data they were gathering.

"You can’t just hope a prompt works," says Xinchi Qi, Co-Founder at Revamp. "It’s all about testing and validating every single update to see how it holds up in production."

Here’s where Vellum’s Prompt Sandbox became a game-changer:

A/B testing prompts and models to find what works best Experimenting with open-source and cost-effective models Iterating quickly on prompts and saving both time and resources

By moving away from “vibe-based” prompt engineering and adopting a test-driven approach, Revamp has been able to keep their prompts at the highest quality.

> "Every decision we make is backed by data, which gives us confidence that we’re building something reliable," Xinchi concludes.

# 50% Faster Debugging

Debugging AI workflows can feel like untangling a ball of yarn — one wrong output can leave you chasing threads for hours. For Revamp, managing over 15 million executions every month meant that even small errors could snowball into larger problems. They needed a way to debug issues quickly and efficiently, without wasting precious time.

> "We wouldn’t exist without Vellum," says Xinchi Qi, "The ability to version prompts in production saved us countless engineering hours."

With Vellum’s Observability product , debugging became seamless, allowing Revamp to maintain the quality of their AI-generated messages at scale.

### Track every execution

When you’re running millions of executions, having a clear log is crucial. Vellum logs each execution, allowing Revamp to track trends, spot issues, and identify patterns in underperforming models.

Beyond fixing issues, these logs create opportunities. By capturing executions, Revamp collects labeled data to fine-tune their models and continuously improve performance.

> "The execution logs are like a playbook for us," says Xinchi. "We can see what’s working, what’s not, and where we need to make changes. On top of that, this data becomes the foundation for fine-tuning our models to make them even better."

### Effortless Version Control

With Vellum, Revamp can instantly trace an issue back to the inputs that caused it. By saving problematic scenarios, they can quickly tweak prompts in the sandbox and test again.

"Fixing errors that used to take hours now takes minutes," Xinchi shares. "We can trace inputs, outputs, and everything in between, and with Vellum, we can confidently update prompts knowing we’re not introducing new issues. Every update is backed by data."

# Deploy updates with no delay

For Revamp, one of the biggest advantages of using Vellum is the decoupled deployment system .

Revamp can publish updates to their prompts or AI features without having to redeploy the entire app. This means their team can iterate and roll out changes in real-time, responding to customer feedback or improving performance without downtime or delays.

"With Vellum, we can push a new prompt into production with just one click," says Xinchi Qi. "There’s no waiting, no app-wide redeployment. We make a change, and it’s live immediately."

This flexibility allows Revamp to test, refine, and improve their AI faster than ever.

Whether it’s tweaking a prompt for better engagement or testing a new model, the process is seamless and risk-free.

"The ability to update a single prompt without touching the rest of the system has been a lifesaver," adds Xinchi.

> ‍ "We can move quickly without worrying about breaking other parts of the app."

# 15 Million Executions, Zero Problems

Scaling AI to handle 15 million executions per month is no small feat. For Revamp, each execution represents more than just data — it’s a moment of connection: a tailored email, a thoughtful product recommendation, or a perfectly timed reminder. At this scale, the stakes are high, and there’s no room for inefficiency or error.

With Vellum , Revamp has completely transformed the way they build, manage, and deploy their AI workflows. From seamless debugging to effortless version control, Vellum has removed the roadblocks that could have slowed them down.

"Vellum isn’t just a tool for us," says Xinchi Qi, Co-Founder at Revamp. "It’s the backbone of everything we do, helping us deliver reliable, high-quality experiences at scale."

At this scale, team alignment is just as important as technical reliability. Revamp relies on Vellum’s collaboration tools to ensure everyone is always on the same page.

"With Vellum, we’re all on the same page," Xinchi explains.

> ‍ "If I’m reviewing a prompt comparison, I can share it instantly, and my team can see exactly what I’m looking at. It’s made collaboration so much easier and faster."

# Offload Your AI Complexity to Vellum

Revamp’s journey shows that scaling AI doesn’t have to come with overwhelming complexity. With Vellum, they’ve turned challenges into opportunities: managing 15 million executions seamlessly, rolling out prompt updates in real-time, and empowering their team with unmatched collaboration tools.

Whether you’re struggling with debugging, versioning, or simply moving faster without breaking things, Vellum can help.

Schedule a demo today
