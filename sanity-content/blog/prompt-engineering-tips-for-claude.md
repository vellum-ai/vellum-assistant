---
title: "Prompt Engineering Guide for Claude Models"
slug: "prompt-engineering-tips-for-claude"
excerpt: "Learn how to prompt Claude with these 11 prompt engineering tips."
metaDescription: "Learn how to prompt Claude with these 11 prompt engineering tips."
metaTitle: "12 prompt engineering tips to boost Claude's output quality"
publishedAt: "2024-02-02T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Unlock the full potential of Claude for your LLM features."
imageAltText: "Cover for prompt engineering blog post"
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/2105c2e318f744026b7076d793daeaad12dfec73-1107x762.png"
---

Have you tried instructing any Claude model in the same way as you would GPT-4?

Given the widespread use and familiarity with OpenAI's models, it's a common reflex.

Yet, this approach doesn't quite hit the mark with these models.

Claude models are trained with different methods/techniques, and should be instructed with specific instructions that cater to those differences. So, I looked into Anthropic's official docs , and tried to use their guidelines to improve the LLM outputs for our customers.

Turns out, Claude models, specifically Claude 3 Opus, can do even better than GPT-4 if you learn to prompt it right.

The official documentation can be a bit confusing, so this guide will show you the most useful prompt engineering techniques. We've also developed a prompt converter; just paste your GPT-4 prompt and get an adapted Claude 3 Opus version. Try the tool here .

Now let's learn how to prompt Claude.

‍

1. Use XML tags to separate instructions from context

The Claude models have been fine-tuned to pay special attention to the structure created by XML tags, and it won’t follow any random indicators like GPT does. It’s important to use these tags to separate instructions, examples, questions, context, and input data as needed.

For example you can add text tags to wrap the input:

Summarize the main ideas from a provided text. &lt;text&gt; {input input here} &lt;/text&gt;

You can use any names you like for these tags; there are no specific or exclusive names required. What's important is the format. Just make sure to include &lt;&gt; and &lt;/&gt; , and it will work fine!

‍

2. Be direct, concise and as specific as possible

This is equally important for every large model.

You’ll need to clearly state what the model should do rather than what it should avoid. Using affirmatives like “do” instead of “don’t” will give you better results.

Provide Claude with detailed context and clearly specify which tag to use to find this information.

Here’s how we can improve the above prompt:

Summarize the main ideas from the provided article text within the &lt;text&gt; tags . &lt;text&gt; {input input here} &lt;/text&gt;

‍

3. Help Claude with the output

The biggest problem with generally all Claude models is that it tends to be very chatty in its answers. It will always start with a sentence or two prior to providing the answer, despite being instructed in the prompt to follow a specific format.

To mitigate this, you can use the Assistant message to provide the beginning of the output. This technique will ensure Claude always begins its answer the same way.

Here’s how that prompt will look like if we want Claude to follow a specific format:

Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below: &lt;format&gt; → idea 1 → idea 2 → idea 3 &lt;/format&gt; &lt;text&gt; {input input here} &lt;/text&gt;

Assistant: →

‍

4. Assign a role

Always assign a role. If you’re building an AI-powered writing tool, start your prompt with “You’re a content writer…”, or better yet "You're the best content writer in the world!". Using the previous technique of putting the first token in the Assistant’s response, you can also force Claude to stay in character.

For example:

You’re Jack, the best content writer in the world. Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below: &lt;format&gt; → idea 1 → idea 2 → idea 3 &lt;/format&gt; &lt;text&gt; {input input here} &lt;/text&gt;

Assistant: [Jack, the best content writer in the world] →

‍

5. Give Claude time to think

There are some cases when it can be beneficial to explicitly instruct Claude to generate extra text where it reasons through the problem. To achieve this, you can instruct Claude to first "think through the problem" and then provide the answer. You can request that Claude outputs this process with two separate XML tags: one for the "thinking" part and another for the "answer.", like in the prompt below:

You’re Jack, the best content writer in the world. Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below: &lt;format&gt; → idea 1 → idea 2 → idea 3 &lt;/format&gt; When you generate the answer, first think how the output should be structured and add your answer in &lt;thinking&gt;&lt;/thinking&gt; tags. This is a space for you to write down relevant content and will not be shown to the user. Once you are done thinking, answer the question. Put your answer inside &lt;answer&gt;&lt;/answer&gt; XML tags. &lt;text&gt; {input input here} &lt;/text&gt;

Here’s what the model will output if we provide some text about Biochemistry (the prompt was cut down to highlight the format of the output):

You’re Jack, the best content writer in the world. Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below: &lt;format&gt; → idea 1 → idea 2 → idea 3 &lt;/format&gt; Assistant: &lt;thinking&gt; Here are the 4 key ideas I would summarize from the text: 1. Biochemistry explores chemical processes in living organisms by…. &lt;/thinking&gt; &lt;answer&gt; → Biochemistry explores chemical processes… → It plays a vital role in health and medicine… &lt;/answer&gt;

Notice that the &lt;answer&gt; text doesn’t start with an arbitrary sentence, so you’ll always get the expected output format in this tag. You could easily apply some data manipulation, and cut the "thinking" tags, and extract the answer.

‍

6. Provide Examples

Few-shot prompting is probably the most effective way to get Claude to give very good answers. Including a couple of examples that might generalize well for your use case, can have high impact on the quality of the answers. The more examples you add the better the response will be, but at the cost of higher latency and tokens.

You’re Jack, the best content writer in the world. Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below: &lt;format&gt; → idea 1 → idea 2 → idea 3 &lt;/format&gt; Here is an example on how to respond in a standard interaction: &lt;example&gt; {input examples here} &lt;/example&gt; &lt;text&gt; {input input here} &lt;/text&gt;

‍

7. Let Claude say "I don't know"

To prevent hallucinations just add the phrase shown in the prompt below

Answer the following question only if you know the answer or can make a well-informed guess; otherwise tell me you don't know it.

‍

8. Long documents before instructions

If you’re dealing with longer documents, always ask your question at the end of the prompt. For very long prompts Claude gives accent to the end of your prompt, so you need to add important instructions at the end. This is extremely important for Claude 2.1.

&lt;doc&gt; {input document here} &lt;/doc&gt; You’re Jack, the best content writer in the world. Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below:

‍

9. Think step by step

You can significantly improve the accuracy, by adding the phrase “Think step by step” that will force Claude to think step by step, and follow intermediate steps to arrive to the final answer. This is called zero-shot chain of thought prompting and we wrote more on that in this blog post.

‍

10. Break complex tasks into steps

Claude might perform poorly at complex tasks that are composed of several subtasks. If you know who those subtasks are, you can help Claude by providing a step by step instructions. Something like:

You’re Jack, the best content writer in the world. Summarize the main ideas from the provided article text within the &lt;text&gt; tags, and only output the main conclusions in a 4 bulleted list. Follow the format provided below: &lt;text&gt; {input input here} &lt;/text&gt; Please follow this steps: 1. Write a one paragraph summary for {{text}} 2. Write 4 bulleted list with the main conclusions for {{text}}

‍

11. Prompt Chaining

If you can’t get reliable results by breaking the prompt into subtasks, you can split the tasks in different prompts. This is called prompt chaining, and is very useful at troubleshooting specific steps in your prompts.

‍

12. Look for Relevant Sentences First

All Claude models can recall information very good across their 200K context window (they passed the "Needle in a Haystack" test with 95% accuracy). But, the models can be reluctant to answer questions based on an individual sentence in a document, especially if that sentence has been injected or is out of place.

To fix this, you can add start the Assistant message with " Here is the most relevant sentence in the context:” , instructing Claude to begin its output with that sentence. This prompt instruction achieves near complete fidelity throughout Claude 2.1’s 200K context window .

Assistant: Here is the most relevant sentence in the context:

‍

Test-driven prompt engineering with Claude

These best practices for Claude can help you write a solid first prompt. But, how can you determine if this method is effective across a wide range of user inputs?

To build confidence in your prompt, you can follow a test-driven prompt engineering approach.

You can compile a collection of test scenarios and apply them to various configurations of your prompt and model. Continue this process until you’re satisfied with the outcome.

Remember, constant iteration is key here. Even after pushing your prompt to production, it’s critical to monitor how it’s doing against live traffic and run regression tests before deploying any changes to your prompts.

If you need help with evaluating your prompts while you’re prototyping or when they’re in production — we can help.

Vellum provides the tooling layer to experiment with prompts and models, evaluate at scale, monitor them in production, and make changes with confidence.

If you’re interested, you can book a call here. You can also subscribe to our blog to stay tuned for updates.

‍

# FAQ

‍

## What is the main difference between Claude 2 and Claude 2.1?

The primary distinction is that Claude 2.1 features a context window that is twice as large (200,000 tokens) and introduces the ability to make function calls, a functionality that was previously exclusive to OpenAI models.

In addition to that, it demonstrates better recall capabilities, hallucinates less, and has better comprehension across a very big context window.

So, Claude 2.1 is a perfect model to handle longer, more complex documents like legal docs, and Claude 2 is great at text processing suitable for many other applications.

## How large is Claude's context window?

Claude 2.1 leads in context prompting capabilities, supporting a maximum context window of 200,000 tokens, the highest available among models. This amounts to roughly 500 pages of information, or the equivalent of one Harry Potter book!

## Does Claude 2 by Anthropic support function calling?

Yes, but currently limited to select early access partners. With the function calling option you can pass Claude a set of tools and have Claude decide which tool to use to help you achieve your task. Some examples include:

Function calling for arbitrary functions Search over web sources Retrieval over private knowledge bases

## Table of Contents

Use XML tags Be direct and specific Help Claude with the output Assign a role Give Claude time to think Provide examples Let Claude say "I don't know" Long documents, then instructions Think step by step Break complex tasks into steps Prompt chaining Test-driven prompt engineering Look for relevant sentences
