---
title: "The Six Levels of Agentic Behavior"
slug: "levels-of-agentic-behavior"
excerpt: "A look at AI's evolution from basic, rule-based systems to fully creative agentic workflows."
metaDescription: "A look at AI's evolution from basic, rule-based systems to fully creative agentic workflows."
metaTitle: "LLM Agents: The Six Levels of Agentic Behavior"
publishedAt: "2025-12-03T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: true
guestPost: false
isGeo: true
authors: ["Anita Kirkovska", "Nico Finelli", "David Vargas"]
reviewedBy: "Nicolas Zeeb"
category: "Guides"
tags: ["Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/158f4fb0ceb05c59e5ff3abb57c8398fe6815369-1232x928.heif"
---

## Quick overview

Agentic behavior in AI refers to how autonomous and decision-capable a system is, ranging from simple task automation to fully autonomous agentic systems.

This article explains each level of agentic behavior so you can identify where your AI systems are today and what it takes to evolve them into agents that act, learn, and improve on their own.

Level Definition Example L0: Reactive Follows direct instructions with no awareness or learning. A rule-based chatbot or basic script. L1: Context-Aware Understands limited context and adjusts responses slightly. An assistant that remembers recent inputs. L2: Goal-Oriented Acts toward defined goals and plans simple steps to reach them. A scheduling agent that finds the best meeting time. L3: Self-Improving Learns from outcomes and refines future decisions. An AI model that adapts from user feedback. L4: Collaborative Coordinates with other agents or systems to achieve shared goals. A multi-agent setup managing complex workflows.

‍

## The six levels of agentic behavior

Everyone’s racing to build AI agents, but ask five engineers what that actually means, and you’ll get five different answers. Instead of debating definitions, let’s talk about what really matters—what these systems can actually do.

How much autonomy, reasoning, and adaptability do they have? Where do they hit a wall? And how close are we to agents that can truly operate on their own?

That’s where things get interesting.

At the end of the day, every AI system has some level of autonomy, control, and decision-making. But not all autonomy is the same.

To make sense of this, we put together a six-level framework (L0-L5) that breaks it down. The idea comes from how AVs define autonomy — not as a sudden jump, but as a gradual, structured progression. Self-driving cars don’t reach L3+ autonomy without first mastering lane assist, adaptive cruise, and automated parking—each capability building on the last.

AI agents follow the same pattern, with each level adding more complexity, reasoning, and independence.

Below is how we break it down. If you’ve got thoughts, we’d love to hear them—this is one of those topics we could talk about for hours.

## L0: Rule-Based Workflow (Follower)

At this level, there’s no intelligence—just if-this-then-that logic. Think of it like an Excel macro:

No decision-making —just following predefined rules. No adaptation —any changes require manual updates. No reasoning —it doesn’t "think," just executes.

Examples? Traditional automation systems like Zapier workflows, pipeline schedulers, and scripted bots. Useful, but rigid —they break the moment conditions change.

## L1: Basic Responder (Executor)

Now, we start seeing a tiny bit of autonomy.

At this level, AI can process inputs, retrieve relevant data, and generate responses based on patterns. But it still lacks real agency—it’s purely reactive , doesn’t plan, and has no memory.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9264ddb0f0fe3b19afff385628de379c06bbdded-3035x451.png)

‍

But here’s the key limitation: no control loop. No memory, no iterative reasoning, no self-directed decision-making.

It’s purely reactive.

As we move up the levels, you’ll see how small changes—like adding memory, multi-step reasoning, or environment interaction—start unlocking real agency.

## L2: Use of Tools (Actor)

At this stage, AI isn’t just responding—it’s executing. It can decide to call external tools , fetch data, and incorporate results into its output. This is where AI stops being a glorified autocomplete and actually does something. This agent can make execution decisions (e.g., “Should I look this up?”).

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/bc98f35e2a4971c46993b848d4ff3da759c852c7-2839x836.png)

The system decides when to retrieve data from APIs, query search engines, pull from databases, or reference memory . But the moment AI starts using tools, things get messy. It needs some kind of built-in BS detector—otherwise, it might just confidently hallucinate the wrong info.

Most AI apps today live at this level. It’s a step toward agency, but still fundamentally reactive—only acting when triggered, with some orchestration sugar on top. It's also doesn't have any iterative refinement—if it makes a mistake, it won’t self-correct.

## L3: Observe, Plan, Act (Operator)

At L2 , AI isn’t just reacting—it’s managing the execution . It maps out steps, evaluates its own outputs, and adjusts before moving forward.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/c27c967e8a9b64e0be423efd2986e2af04b25ff4-5863x1804.png)

Here’s what changes:

Detects state changes – Watches for triggers like DB updates, new emails, or Slack messages. Plans multi-step workflows – Doesn’t just return output; sequences actions based on dependencies. Runs internal evals – Before moving to the next step, it checks if the last one actually worked.

It’s a big step up from simple tool use, but there’s still a limit—once the task is complete, the system shuts down. It doesn’t set its own goals or operate indefinitely. Even when Sam and his team ship GPT-5, it’ll still be stuck at L2—a fancy orchestrator, not a truly autonomous agent.

Right now, these workflows are closer to sophisticated automation than agency.

Powerful? Absolutely. Self-directed? Not quite.

## L4: Fully Autonomous (Explorer)

At L3 , agents start behaving like stateful systems. Instead of running isolated task loops, they:

Maintain state – They stay alive, monitor environments, and persist across sessions. Trigger actions autonomously – No more waiting for explicit prompts; they initiate workflows. Refine execution in real time – They adjust strategies based on feedback, not just static rules.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/67c489e95dc67aed8be8e2070110df854a10377e-6966x1796.png)

This starts to feel like an independent system. It can “watch” multiple streams (email, Slack, DBs, APIs), plan actions, and execute without constant human nudging.

But we’re still in the early days.

Most L3 agentic workflows today don’t reliably persist across sessions, adapt dynamically, or iterate beyond predefined loops. The key word here is "reliably." There are some solutions—but do they actually work well? Debatable.

## L5: Fully Creative (Inventor)

At this stage, AI isn’t just running predefined tasks—it’s creating its own logic, building tools on the fly, and dynamically composing functions to solve problems we don’t yet have answers to. It’s not just following anything; it’s designing its utilities from scratch based on the task it has.

We’re nowhere near this yet.

Today’s models are still overfitting— they’re good at regurgitating, bad at real reasoning.

Even the most powerful models (e.g. o1, o3 , Deepseek R1) still overfit, and follow hardcoded heuristics.

But this is the goal: AI that doesn’t just follow instructions but figures out new ways to improve, create, and solve problems in novel ways.

## Where are we now?

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/bc127570dbddd3d2b71fdc6727e35d9a5ae0dc72-4724x2834.png)

Here at Vellum, we’ve worked with companies like Redfin, Drata, and Headspace —all deploying real-world AI applications. And here’s what we’re seeing:

Most AI systems today sit at L1.

The focus is on orchestration—optimizing how models interact with the rest of the system, tweaking prompts, optimizing retrieval and evals, and experimenting with different modalities. These are also easier to manage and control in production — debugging is somewhat easier these days, and failure modes are kinda predictable.

L2 is where most of the action is happening right now.

Models like O1, O3-mini, and DeepSeek are paving the way for more intelligent multi-stage workflows. We're also seeing some really cool new products and UI experiences pop up as a result.

Most enterprises don’t touch L2—for now, it’s almost entirely startups pushing this space. There’s a reason most production AI workflows are still human-in-the-loop—LLMs don’t handle edge cases well, and debugging an agent that went off the rails three steps ago is a nightmare.

L3 and L4 are still limited.

The tech just isn’t there yet—both at the model level ( LLMs cling to their training data like a security blanket ) and at the infrastructure level, where we’re missing key primitives for real autonomy.

## Current limits

Even the most powerful models still overfit like crazy .

Last week, we ran an eval using well-known puzzles—ones these models have definitely seen in training. Then we tweaked them slightly. The results? The models couldn’t adapt and just regurgitated the solutions they learned, even when they didn’t fit the new version of the problem.

Take DeepSeek-R1—trained primarily with pure RL instead of a massive corpus. You’d think it would generalize better, right? Nope. Still overfits . Feels like we’re staring at a local maxima with these models.

And here’s the problem: truly autonomous agentic workflows depend on models that can actually reason, not just remix training data. Right now, we’re nowhere close.

So yeah, we’ll see incremental improvements. But a real leap to L3 or L4?

Not a sure thing. It might take a fundamental breakthrough ( looking at you, Ilya Sutskever )—or we might just be stuck here for a while.

## Move up the stack with Vellum

If AI agents are going to move up the stack, teams need better ways to test, evaluate, and refine their workflows.

That’s where Vellum comes in.

Right now, most AI development relies on trial-and-error—tweaking prompts, adjusting logic, and hoping for the best. But as your workflows become more complex (especially at L2+), debugging becomes a nightmare. One wrong tool call, one bad retrieval step, and everything breaks three layers deep.

Vellum provides strong unit and end-to-end workflow testing to make iteration faster and more effective. Whether you're refining agent logic or testing edge cases, a flexible framework can help you to reliably move up the L0-L4 stack.

Book a call t o chat with one of our AI experts and see how Vellum can help you move up the stack.

{{general-cta}}

## Extra resources

Beginner’s Guide to Building AI Agents → Best Enterprise AI Agent Builder Platforms → Best Low code AI Workflow Automation Tools → Guide: No Code AI Workflow Automation Tools → Best AI Workflow Platforms →

## FAQs

1) What does “agentic behavior” mean in AI?

Agentic behavior describes how independently an AI system can reason, decide, and act toward goals without human input. With Vellum, teams can prototype and build AI agents by prompting Vellum with natural language or by manually drag-and-dropping nodes in the Workdlow sandbox. These agents range from simple task automations to production grade agentic systems.

2) Why does understanding levels of agentic behavior matter?

Understanding these levels helps organizations assess their AI maturity and plan safe, scalable upgrades. Vellum makes this easier by letting you visualize and orchestrate agent workflows using shared components and version-controlled logic.

3) How is agentic behavior different from automation?

Automation follows fixed rules, while agentic systems adapt based on context and goals. Vellum combines both through reusable components that support deterministic automation and adaptive decision-making in one collaborative environment.

4) Can AI agents make mistakes when acting autonomously?

Yes, which is why version testing and evaluations are critical. Vellum includes an Evaluations sandbox, human-in-the-loop review, mock inputs/tools, and transparent execution logs in the Workflow Console that help teams validate agent outcomes before and after deployment.

5) What technologies enable higher levels of agentic behavior?

Language models, retrieval systems, and orchestration frameworks are key enablers. Vellum provides an integrated platform to experiment with memory, context passing, and reasoning strategies without needing to rebuild infrastructure.

6) Where does Vellum fit in this framework?

Vellum serves as the foundation for building, testing, and managing agentic systems collaboratively. It reduces engineering overhead by giving teams a visual, centralized space to design and control agent behavior.

7) How do multi-agent systems work?

Multi-agent systems use specialized agents that share context and work together toward a common objective. Vellum supports these setups through collaborative workflows and sandboxed environments that make coordination and monitoring easier.

8) What are the risks of advancing too quickly toward full autonomy?

Overextending autonomy can lead to unpredictability or performance drift. Vellum helps manage this by tracking every version and run so teams can roll back changes, compare results, and maintain safe levels of control.

9) How can I measure my AI’s level of agentic behavior?

Evaluate autonomy, goal tracking, and adaptability. Within Vellum, these traits can be observed directly through execution traces and evaluation sets, making it easy to benchmark progress over time.

10) How does agentic behavior relate to AI governance and safety?

Higher autonomy requires versioning and evaluations paired with governance features. Vellum supports governance with audit trails, permission controls, and reproducible run histories that keep agent behavior transparent and trackable.
