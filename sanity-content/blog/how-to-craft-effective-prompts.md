---
title: "How to craft effective prompts "
slug: "how-to-craft-effective-prompts"
excerpt: "A curated list of best practices, techniques and practical advice on how to get better at prompt engineering."
metaDescription: "A curated list of best practices, techniques and practical advice on how to get better at prompt engineering."
metaTitle: "How to craft effective prompts "
publishedAt: "2025-08-05T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Compare Models and Prompts with Vellum"
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/ae6bef45b3837ece046e746f26fb897d94ab02f7-1748x941.png"
---

Prompt engineering is one of those job functions that suddenly became a thing.

Two years ago, the term was scattered across a few white-papers, just relevant to niche research circles. But today, it’s a hot sought-after skill — just look at all the open positions on this job board . Given the recent explosion of business-ready AI, it’s to little surprise.

Admittedly, the definition of prompt engineer is vague; some might argue that anyone using an LLM is a prompt engineer. But the term tends to refer to those that are building something instrumental with LLMs, like an AI-powered application or a business-critical functionality.

For those problems, messy prompts with tacked-on clarifications aren’t forgivable. Instead, prompts need to render accurate, correctly-formatted, and affordable results.

At Vellum, we’ve partner with hundreds of companies who are at the forefront of building reliable AI systems in production. We worked with product, engineering, and marketing teams who must adopt good prompt engineering skills in order to succeed in their job.

From designing prompts and architectures to scaling evaluations, we’ve figured out what makes a great prompt engineer—and great prompts. Now, we’re excited to share these insights with you. Let’s get into the details.

## Why prompt engineering

These days, knowing how to do prompt engineering can make you significantly better and more productive at your daily job—whether you're a Product Manager, Developer, or in any other role. It’s a skill that helps you get the most out of AI tools and makes solving problems faster and more effective.

It’s also a skill that can land you a high-paying technical role. AI startups have raised $48.4 billion so far this year and are hiring across various functions. If you have even a basic understanding of AI, you’ll have a strong advantage in the job market.

However, to own the prompt engineering process, you must remain educated on emerging prompt engineering techniques. The space is quickly changing as new AI models evolve and more complex tasks become conquerable. Without constantly up-skilling yourself on new techniques, your prompts will fall behind industry standards.

Sign up to our newsletter to stay in the loop, and keep reading for more tips and insights that will help you become the best prompt engineer.

## Getting started

In this section, we won’t cover specifically how to prompt ChatGPT to do some basic tasks, there are many resources for that.

Instead, we’ll focus on how to approach prompt engineering for scenarios where you're working on AI functionality or building an AI-powered app from the ground up.

No matter your experience, there are three key rules that you need keep in mind as you learn to write great prompts:

### 1. Know exactly what you want to achieve

In coding, using pseudo code to outline your logic before writing the actual code is a common practice. Similarly, with prompt engineering, you should first clearly outline all your goals for your prompt.

Here is a list of questions you should answer:

Will I need both static and dynamic content for my prompt? How will I pass dynamic variables? What should the output be? (JSON, String, XML) Do you need to add external context or is the LLM familiar with the task? Are there any limits or constraints on the response (length/format) Do you need to tweak some of the LLM parameters? Which ones?

The more precisely you understand your objectives, the easier it becomes to construct a prompt that delivers the desired results. Sometimes, collaborating with your co-workers is the best way to iron-out these requirements, especially if multiple departments or app functions are at stake.

### 2. You can’t afford to skip experimentation

LLMs aren’t perfect, and neither is prompt engineering.

Every rule in this document should be taken with a grain of salt. The best way to really vet if your prompt engineering is optimal is to test different things . Try different techniques, provide examples, split your prompts for more control, and tweak the little details. We’ll give you all the tools you need to do this properly in the next sections.

But make sure you’re aware that an LLM is never equally capable for all the possible tasks; there is a fair amount of variance, and only by scrutinizing your prompts will you be able to determine if your strategy is optimal.

### 3. LLMs are not humans

Whether you are a developer or not, the first rule to remember when thinking about prompt engineering is that LLMs aren’t humans. For lack of a better word, LLMs are obedient in nature. They thrive with strict directions. They aren’t designed to freestyle.

They just are also different . Some things that are obvious to a human aren’t clear to an LLM; likewise, complex instructions that a human would stumble over, an LLM can accomplish flawlessly.

Finally, remember this: LLMs will never say, “I don’t know”, out of the box. They’re programmed to always provide an answer , even when they don’t actually know it. This can lead to what we call "model hallucinations," so it’s crucial to manage and be aware of this tendency.

### Do these rules differ for developers and non-developers?

Both developers and non-developers can interact with LLMs in the same way. While developers might have an edge with logical reasoning, prompt engineering is a skill that anyone can pick up with practice.

The outcome , however, for non-technical folks versus developers can vary:

For non-developers, prompt engineering can strictly be prompt structure and performance. It’s like writing a good email to a co-worker that you don’t know very well. Clarity is the north star. Vagueness is a curse. Detail helps. Too much detail could hurt. A good prompt is simply striking the right balance between these things in order to achieve high performance.

For developers, the focus is more on how to integrate LLM outputs into their existing code. They see prompts as part of their AI functionality and think about how to make these outputs work smoothly in their systems. JSON outputs are often ideal for this, but getting valid JSON responses can be tricky and requires a bit of trial and error to get right.

Let’s look at some best practices.

## Best Practices

First things first: Do prompt engineering techniques depend on the model?

### Different model, Different prompting design?

The tough thing about prompt engineering is that good advice for GPT-4o may not apply directly to Claude 3.5 Sonnet (in fact, Claude 3.5 Sonnet might require different prompts from GPT-4 ). Different tier models introduce more challenges — stronger models are better at inference (e.g. GPT-4); while others like GPT-3.5 need more spelled out commands . The key learning here is there are generally good practices surrounding prompt engineering, but you should also check out model-specific advice.

There are some excellent resources on specific model prompt engineering:

Imaginary Cloud’s guide on How to prompt GPT-4 Our guide on How to prompt Claude 3.5 Sonnet Our guide on How to prompt GPT-3.5 Evan Armstrong’s guide on How to prompt Llama-3 Cobry’s guide on How to prompt Gemini

Also, we’ve created two free tools that can help you write better prompts for specific models:

GPT-4 to Claude prompts : Optimize your GPT-4 prompts for Claude models Objective to Claude Prompts : Write your prompt objective and get an optimized prompt for Claude models

You can dive into the specific guides linked above, or bookmark them for later and keep reading for more tips on creating great prompts.

‍

## Six tips for great prompt design

‍

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/3e7f09617c915f439ec8798f2b08beb70c41c6fc-1748x828.png)

We’ve already figured out that some models need specific prompt structures, but there are a few general rules that apply across the board. Let’s take a quick look at what those are.

### 1) Specific input = better response

When designing prompts, it's important to be crystal clear about what you want. Vague prompts will lead to vague or incorrect responses. Break down complex tasks into smaller, more manageable pieces if needed and chain your prompts .

Be as specific as you can about things like the desired format, level of detail in the response, tone and style.

### 2) Provide context to avoid hallucinations

No LLM can know everything, especially when it comes to specific details about your industry or domain. If you want the LLM to incorporate your unique insights, you’ll need to provide that context during inference.

In some cases, static context will do. Just write all the information you’d want the LLM to have when it’s answering a user query. In other cases, you might need to pass dynamic context, as the context lengths of various models can be limiting. Here’s more info on context length .

In that case, you can do follow RAG based approach, where you can dynamically add context in your prompts based on the user query. Read more about it here .

### 3) Separate your Instructions from Context

At this point, you can imagine that your prompts can become very lengthy — in such case you need to explicitly tell the model where to find specific information.

OpenAI suggests that you always start with the instruction, and then separate it with the rest of the elements using ### or “”” . See below for how to do it:

### Instructions ### Summarize the main ideas for the given text. ### Text ### {Context here}

### 4) Tell the model what to DO instead what NOT to do

In most cases, you'll notice the model adding extra information or unnecessary characters to your responses. Your first instinct might be to tell the model what not to do. But models don’t follow that logic — clear positive instructions works more reliably than telling the model what not to do.

For example, if you only want the final answer to a math problem, say, “Only output the final answer,” instead of, “Don’t include explanations.”

### 5) Assign a role

Models perform much better when they know their role. You should assign this role at the start of your prompt. For example: "You’re the world’s best content writer. You’ll write highly engaging articles on a given topic provided by the user." This helps guide the model to produce the desired results more effectively.

### 6) Add examples

Even with the best prompt design and context, the model may still struggle to replicate the level of reasoning you need for certain answers.

This usually happens for more complex tasks where the model actually need to see an example or think about the problem before it provides the answer.

In such cases we use specific prompt engineering techniques like one-shot, few shot, chain of thought prompting and others that we’ll cover in the next section.

‍

## Techniques

There are a few universal prompt engineering techniques that’ll prove useful for a grand majority of LLMs. Mastering these techniques will make you a better prompt engineer.

### One-Shot

One-shot is a technique where an example response is provided to guide the model’s response. This enables the model to deliver the correct output format via mimicry, but also without extensive training.

Generate a recipe for banana pudding. Example recipe: "Ingredients: Bread, Ham, Cheese, Butter, Sesame Seeds. Step 1: Heat the bread at medium heat in a toaster for 4 minutes ..."

One-shot contrasts with zero-shot , the default case where no example is provided, forcing the model to use intuition. In our experience, one-shot dramatically improves a model’s efficacy over zero-shot queries.

### Few-Shot

Few-shot is a technique that’s similar to one-shot, but where multiple examples are provided to aid the model. The additional examples increases the likelihood that the model will understand the desired format of the output. It also prevents the model from overly mimicking a single example.

Generate a recipe for banana pudding. Example recipe: "Ingredients: Bread, Ham, Cheese, Butter, Sesame Seeds. Step 1: Heat the bread at medium heat in a toaster for 4 minutes ..." Another recipe: "Ingredients: Rice, Spring Onion, Garlic, Chicken. Step 1: Wash the rice thoroughly. Step 2: Dice the spring onion ..."

Similarly, we’ve found that few-shot queries deliver more reliable results — see more examples of how one-shot and few-shot compare.

### CoT (Chain of Thought)

CoT, or Chain of Thought, is a prompting technique that encourages the model to break down complex problems into step-by-step processes. CoT is similar to One-Shot prompting; however, instead of just providing an example response, it also includes the intermediary reasoning.

Q: A train travels 20 miles east. Then, the train travels 10 miles north. Finally, the train travels 10 miles east. How far east has the train traveled? A: (step) travels 20 miles east. (step) travels 10 miles north. (total) has traveled 20 miles east and 10 miles north. (step) travels 10 miles east. (total) has traveled 20 miles east, 10 miles east, and 10 miles north. (combine) 20 miles east + 10 miles east is 30 miles east. (total) has traveled 30 miles east and 10 miles north. Q: A train travels 15 miles west. Then, the train travels 5 miles south. Finally, the train travels 5 miles west. How far west has the train traveled?

Our users have dramatically improved the efficacy of their prompts by using CoT for any logical query. It’s particularly helpful for math or math-adjacent problems.

We wrote a whole guide on chain of thought prompting — read it here .

### Prompt Caching

Prompt caching is a technique that stores previously generated responses to avoid redundant API calls and reduce latency. Prompt caching is particularly useful for frequently asked questions or similar queries. It helps optimize costs and minimizes latency, dramatically improving response times.

Currently the only model that supports this option is Anthropic — read how to use it here .

### Meta-Prompting

Meta-prompting is a prompt engineering technique where LLMs are entrusted to write a detailed prompt from a seed prompt. Meta-prompting is useful when writing a complete prompt is difficult, but the overall objective is clear (e.g. writing an easy-to-read recipe).

Meta-prompting is akin to a teacher asking a student to write an outline for their essay before writing the actual essay; it encourages LLMs to plan-ahead when producing content. It also enables humans to intervene if the generated prompt isn’t satisfactory.

Write a good prompt for writing an easy-to-follow recipe for creating a vanilla cake.

Meta-prompting might sound like AI is coming for prompt engineering jobs (with an incredibly twist of irony). But meta-prompting is more about leveraging LLMs to dynamically generate good prompts; it creates its own set of challenges. It’s akin to use an ORM to manage SQL—a layer of abstraction doesn’t eliminate challenges.

What we do know is that meta-prompting can work but it might require a lot of work on the initial prompt. Out of the box, LLMs aren’t really great prompt engineers — so we can’t 100% rely on their capabilities to produce good prompts for our AI systems in production.

### RAG

RAG, however is something that powers most of the AI systems in production today. This is a technique that tackles the limited context windows of LLMs and takes advantage of LLMs ability to determine similarity.

![High level overview of RAG](https://cdn.sanity.io/images/ghjnhoi4/production/a92831185ec0eb00241e3c5f3981d6b61047c871-700x483.png)

With RAG, the LLM is first used to generate embeddings—vectorized representations of your own domain data. These embeddings are stored in a vector database (e.g. pg_vector, Pinecone, Chroma, or OpenAI’s native contextual memory). Then, when a query is made, vector search is run against the database to retrieve contextual data to the user query. That data is then merged with the prompt to generate a context-aware response.

You don’t need to hear our insights to know about the importance of RAG. It is, arguably, the second-biggest innovation (after LLMs ) in the world of AI. And we do believe that mastering RAG is an essential for any prompt engineer — learn how to do it here .

‍

## Engineering the model parameters

Now, let’s assume you have the strongest prompts and all the right context, let’s take you further by adjusting model parameters like temperature, logit bias, top_p and others to refine how the model responds to user queries.

These LLM parameters can be tweaked in every API request that you send to the model. Let’s quickly cover the most used ones and how they can help:

JSON_mode : Ensures the model will always output valid JSON. Presence Penalty : Prevents the model from repeating a word. Frequency Penalty : Prevents the model to repeat a word that was previously used. Structured Outputs : Ensures the model will always output valid JSON that adheres to a provided JSON Schema. Function Calling : Ensures the model will create arguments for functions you’ve defined in the prompt. Logprobs : Show how likely each word (token) is to appear in a sentence based on the words that came before it. Max_tokens : Specifies the maximum number of tokens that can be generated in the output. Logit Bias : Control whether the model should output specific tokens or not. Seed : Receive (mostly) consistent outputs. Stop Sequence : Stop generating tokens at a desired point, such as the end of a sentence or a list. Streaming : Send tokens to the UI in batches so that you can give the appearance of generation like ChatGPT. Temperature : Control how creative the LLM is with the outputs. Top_k : Set the value of “k” for the model to consider only the k most likely tokens. Top_p (Nucleus Sampling): Generate tokens until the cumulative probability exceeds the chosen threshold.

To learn how to use each of these and the use-cases where they're most effective - take a look at our LLM Parameter Guide .

Now that we've covered the basics, let's dive into some engineering courses that can help you take this knowledge to the next level and sharpen your skills even further.

‍

## Educational courses

There are a few good online courses that you can take to become a better prompt engineer. These courses cover the necessary techniques for writing effective prompts that generate accurate results. Many of them are beginner friendly, with no prior-development experience needed.

There are some courses that we recommend:

DeepLearning.ai’s course, sponsored by OpenAI Introduction to Prompt Engineering IBM’s Generative AI course

## How to Get a Prompt Engineering Job?

Getting better at your job with a prompt engineering skill under your belt is very useful. But if you want to get a job as a prompt engineer — you need to build up your practical portfolio and have a good understanding of common prompt design techniques. Some of the prompt engineering roles will require more technical capabilities than others — but it’s usually good to satisfy the following parameters:

Understand the basics of AI (e.g. How do they work, Prompt Design, Available models) Know how to prompt LLM models (format, techniques — everything we covered above) Practical portfolio - Show what you’ve built and document how you did it Have a creative hacker spirit and love solving puzzles Master Python — having coding knowledge will give you better chances to get any prompt engineering role. There are some frameworks that allow for more visual coding — like Vellum .

Here are some job boards and open prompt engineering positions:

Promptly Hired Prompt Engineering Jobs Indeed’s Job Board Zip Recruiter

## Conclusion

As a closing thought, let’s remind ourselves that LLMs are a complex thing. They might be user-friendly and easy to try, but mastering them is a complex science. Admittedly, there is a wishy-wooshy nature to it—LLMs are black boxes, so techniques to conquer them are based on trial-and-error.

But it’s similar to other fields in science, where empirical data is king. And, most importantly, it shows no signs of going away anytime soon.

## Table of Contents

Why Prompt Engineering? How to Approach Prompt Engineering? Best Practices Tips for Great Design Prompt Engineering Techniques More Control with LLM Parameters Prompt Engineering Courses Getting a Prompt Engineering Job
