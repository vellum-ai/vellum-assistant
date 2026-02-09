---
title: "Webinar recap: How Redfin built a reliable AI assistant and launched it nation wide"
slug: "build-trust-in-your-ai-system-with-redfin"
shortDescription: "Now that you’ve built the v1 of your AI system, it’s time to evaluate how reliably it can run — across many test cases. Session II will focus on the strategies, metrics and goals you should set to prepare your system for production. Join us for an in-depth look at how Redfin successfully developed their AI-powered virtual assistant, Ask Redfin, using a test-driven development approach."
dateFrom: "2024-09-18T18:00:00.000Z"
videoRecording: "https://www.youtube.com/embed/EqODPhaH7cU?si=VB9x7W_d6GSuj43Z"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/f8f2e1748575d3022870b437970cbcc10fe1e407-1280x720.png"
---

## Speakers

- **Sebastian Lozano** - Senior Product Manager ([LinkedIn](https://www.linkedin.com/in/sebi-lozano/))

## Recap

As companies race to integrate generative AI, the initial excitement of a proof-of-concept can quickly fade when faced with the realities of production. How do you ensure your AI system is accurate, safe, and reliable enough to put in front of your customers? If you can't trust it, you can't ship it.

In our recent webinar, Championing Gen AI: Bring Your AI Systems to Life Faster , I sat down with Sebi Lozano, Senior Product Manager at Redfin, to discuss this very challenge. Sebi shared how Redfin, a technology-powered real estate company that has saved customers nearly $1.5 billion in commissions, built and launched AskRedfin , its first AI-powered virtual assistant.

Their secret? A rigorous, test-driven development (TDD) approach that put trust and safety at the forefront. Here’s a recap of the key takeaways and best practices from our conversation.

## Key takeaways from the session

Test-Driven Development is Essential: Applying software engineering's TDD principles to AI is no longer a niche idea. Starting with a comprehensive suite of tests is the most effective way to build reliable and predictable AI systems. Systematic Evaluation Beats Gut Feel: Eyeballing a few outputs isn't enough, especially in regulated industries. Redfin built a suite of hundreds of test cases to systematically measure performance on dimensions like correctness and fairness. Teach Your AI to Say "I Don't Know": One of the most powerful ways to combat hallucinations is to explicitly instruct your model to admit when it doesn't have the answer. This prevents it from inventing information and builds user trust. Decouple Prototyping from Coding: Using a platform to experiment with prompts and models allows product managers and other non-engineers to iterate quickly without needing to deploy code for every change, dramatically speeding up the development cycle.

## Best practices for building trustworthy AI

Sebi walked us through the practical steps Redfin took to move from an idea to a production-ready feature now live in 14 markets. Here are the key learnings you can apply to your own projects.

### 1. Start with a measurable user problem

Before AskRedfin, the company had a feature called "Ask a Question." Users would submit a question and wait—sometimes for minutes, hours, or even days—to get a call or text from an agent. The experience was slow and inefficient.

"We thought that experience could be way better," Sebi explained. "Generative AI, when it came up, just felt like a really natural way of solving that problem. We could provide instant answers... and make that conversational experience way more delightful."

The goal wasn't just to use AI; it was to drastically reduce the time-to-answer for customers, moving from hours to seconds. This clear, measurable goal guided their entire development process.

### 2. Adopt a test-driven development (TDD) approach

The biggest theme of our conversation was Redfin's commitment to TDD. As I noted in the webinar, this is an approach we're seeing more and more in the AI world.

"We were pretty worried about just eyeballing, given the sensitivity in the space and the responsibility we had to our users. It felt wrong to just kind of eyeball a few samples of answers and make a gut call on whether it was good or not."

- Sebi Lozano, Senior Product Manager at Redfin

Instead of building first and testing later, Redfin started by defining what a "good" answer looked like. They created a large set of test cases representing a wide range of user questions, from simple to tricky, and used these tests as their benchmark for success. Every change to the prompt, model, or logic was validated against this test suite to ensure it was a genuine improvement and didn't cause regressions.

### 3. Create hundreds of test cases to ensure quality

A TDD approach is only as good as its tests. The Redfin team didn't just write a few dozen tests; they created a comprehensive evaluation suite with "on the order of hundreds or thousands of test cases."

These tests covered critical dimensions, including:

Correctness: Does the AI accurately answer questions based on the provided listing data? Fairness: Does the AI avoid discriminatory language or advice that could violate regulations like the Fair Housing Act? Safety: Does the AI refrain from giving real estate advice, which would violate licensing constraints?

By running their system against this large-scale test suite, they could make data-driven decisions and gain the confidence needed to launch.

### 4. Teach your AI to say "I don't know"

Hallucinations are a major barrier to trust. Redfin tackled this head-on with a two-pronged strategy. First, they used Retrieval-Augmented Generation (RAG) to provide the LLM with specific data about a property listing. Second, they engineered their prompt to give the model a critical escape hatch.

"We also spent a lot of time giving the LLM very specific instructions on how to answer questions, [and] when to say 'I don't know,'" Sebi said.

This is a simple but incredibly powerful technique. By allowing the AI to confidently state when it lacks the necessary information, you prevent it from making things up. As I mentioned in the webinar, this is a crucial tool for anyone building production-grade AI systems.

## How Vellum helps you build AI you can trust

Redfin's journey from concept to a production-ready AI assistant highlights the need for specialized tooling. A test-driven approach requires an infrastructure that supports rapid experimentation, systematic evaluation, and collaboration between product and engineering teams.

Redfin used Vellum's AI product development platform to implement their TDD workflow. Here’s how our tools helped:

Prompt Engineering: Our collaborative environment allowed the Redfin team to iteratively test and refine prompts, quickly finding the optimal combination of instructions and models for their use case. Workflows: Redfin built their multi-step RAG logic using our visual workflow builder, connecting prompts, data sources, and other tools into a single, manageable chain. Evaluations: The team used our evaluation suite to systematically run their hundreds of test cases, compare results, and ensure every change met their high quality bar before deployment.

This approach enabled Redfin to move faster and with greater confidence. As Sebi shared in a recent case study:

"Using Vellum for testing our initial ideas about prompt design and model configuration was a game-changer. It allowed us to work without always needing engineering resources... Vellum’s software, and their knowledgeable team, saved us hundreds of hours."

- Sebi Lozano, Senior Product Manager at Redfin

To learn more about Redfin's journey and see how a test-driven approach can accelerate your AI development, read the full case study: Redfin's Test Driven Development Approach to Building an AI Virtual Assistant .
