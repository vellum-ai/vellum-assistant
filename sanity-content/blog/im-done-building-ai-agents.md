---
title: "I’m done building AI agents"
slug: "im-done-building-ai-agents"
excerpt: "Four lessons from building an agent that builds other agents"
metaDescription: "These are the four lessons Sidd and the Vellum engineers learned from creating an agent that builds other agents, and why the future of AI development isn’t drag-and-drop, it’s describe-and-build."
metaTitle: "I'm Done Building AI Agents"
publishedAt: "2025-11-03T00:00:00.000Z"
readTime: "6 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Sidd Seethepalli"]
reviewedBy: "Nicolas Zeeb"
category: "All"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/92ad78a01dd731844919172b8b8ed600bfda508c-1192x629.jpg"
---

I had a good run for the last 3 years, but it’s time to move on. Building agents by hand is tedious, framework-heavy, and rigid. Frankly I’m over it, and you should be too.

That’s why we spent the last 6 months building our last agent — an agent that can build other agents.

And in the process, it became really obvious that the future isn't about learning another framework or tool with a visual drag-and-drop interface.

It’s so much brighter.

## Drag and drop is dead

The future is describing what you want in words and having it iteratively materialize in front of you - not searching through a dropdown with 50 options and trying to figure out which one sounds the least wrong.

Here are the critical lessons we learned building our last agent, and why they represent a fundamental shift in how we should approach agent development.

## Your tool definitions are everything

The biggest limiter in building Vellum’s agent builder was teaching our agent to use our tools correctly.

You can have the most advanced LLM in the world, but if it can't reliably interact with its environment, it's going to be useless.

That reliability starts with how you define your tools.

Don’t just wrap existing APIs as a tool and call it a day. You have to be incredibly deliberate with your tool definitions and think about every detail:

Tool Names: Is the name clear and unambiguous? Descriptions: Does the description accurately explain what the tool does, its inputs, and its outputs? Argument Names: Are the parameter names intuitive for the model?

Your goal should be to make each tool call as simple as possible for the model. The complexity should lie in the tool’s internal logic, not its interface.

Here’s an easy example: For example, instead of having your agent make three separate API calls to fetch, consolidate, and format user data, combine those steps into one. Create a single tool called getUserProfile that handles everything in one go.

We improved accuracy by giving agents a tool to manage their own content, so they could explicitly save and retrieve information when needed.

## Be flexible with your testing strategy

Folks in software engineering know this classic trade-off: iterate quickly, avoid regressions, or skip writing tests. Reality is that you can only pick two.

Picking between these when building agents on the other hand can be tangibly more difficult because using an overly rigid test benchmarks can kill your momentum. Having no tests on the other hand is also a recipe for disaster.

Here’s how we evolved our testing strategy when building :

### Early stages = Vibes-based testing

Rapid iteration should be your goal when starting out. You're exploring what's possible, so at this point, 'vibes-based' testing is perfect. You interact with the agent, see how it feels, and make quick adjustments. A formal test suite would only slow you down here.

### Later stages = Concrete test suites

As your agent becomes more capable and you start relying on it, its now time to protect against regressions. This is where a concrete test suite becomes essential.

We used evaluation prompts to check for specific outcomes, for example, "Does the prompt node use the model GPT-5" after instructing the agent to change the prompt node to use GPT-5.

Don't let a dogmatic approach to testing stifle innovation in the early days, but don't ship a critical product without a solid regression suite. Both approaches have their place, and the key to the ideal testing strategy is know what stage of agent development you’re and choosing the appropriate testing strategy.

## Stop theorizing and look at the logs

This might be the most important lesson of all. As engineers, we love to theorize about why something isn't working. We debate prompt structures, model choices, and agentic logic. But from all our experience, we learned this simple truth:

You'll learn more from one hour of looking at end-to-end execution traces than from a week of theorizing.

To debug an agent, you have to be able to think like the agent. The only way to do that is to see its entire 'thought' process laid out. Every observation, every tool call, every token generated. Storage is cheap, but tokens are expensive, so you should store everything as much as possible.

In this, user interaction data becomes an invaluable insight that will help you debug and build faster. By reviewing detailed logs of real conversations, you can pinpoint exactly where the agent went off the rails.

Your agent stops being a black box and becomes a deterministic system that you can analyze and improve. So, stopping guessing and save everyone’s time by just looking at the logs.

## Great agents can build their own UI/UX

An agent that just outputs a wall of text is lame. All of us have moved past the command line. Modern applications are interactive, and AI agents should be too.

We taught our agent builder to create and manage its own user interface elements, which completely changed the user experience.

Instead of just saying, "You need to connect your Slack account," our agent can present a "Connect Slack" button directly in the interface. For long-running tasks, it provides dynamic updates on its progress instead of leaving the user staring at a blinking cursor.

This is about creating a partnership between the user and the agent. Full visibility into the agent's process should coexist with smart, reasonable defaults and interactive elements that guide the user.

## The road ahead

This journey has answered many questions, but it has also opened up new ones that we're excited to tackle.

How do we build a real-time workflow composer that shows the agent's plan as it's being built? What does a truly great mobile experience for an "AI engineer in your pocket" look like? How do we design a UX that elegantly handles both background and foreground agents without overcomplicating things?

Just because Im retiring from the old way of building agents doesn't mean the work is done. The real work is just beginning. We're moving from a world where developers build agents to one where agents build agents, empowering everyone to create powerful AI-driven workflows.

That's a future I think is worth building, because I’m over building agents with nodes and especially with code.

If you want to check out what we’re building, go to vellum.ai

{{general-cta}}
