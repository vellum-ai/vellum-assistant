---
title: "How can I get GPT-3.5 Turbo to follow instructions like GPT-4?"
slug: "prompt-engineering-tips-to-boost-gpt-3-5-to-gpt-4-level"
excerpt: "Learn prompt engineering tips on how to make GPT-3.5 perform as good as GPT-4."
metaDescription: "Learn prompt engineering tips on how to make GPT-3.5 perform as good as GPT-4."
metaTitle: "11 prompting tips to make GPT-3.5 as good as GPT-4"
publishedAt: "2024-02-15T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Use advanced tools to evaluate models and prompts for your use-case."
imageAltText: "A funnel illustration"
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/ab2a3b368f2de42c239dd2d873af6919af19c0a4-984x677.jpg"
---

Today, GPT-4 is performing really well for various use-cases. Even simple prompts can go a long way. The model just understands the instructions.

However, it comes at a cost. When you run it in production for thousands of requests, you’re starting to think if you can decrease the cost either by using another model or by fine-tuning your own.

The easiest option is to use something that’s familiar to you, and that would be the 2nd ranked model or GPT-3.5. This model is significantly cheaper than GPT-4, costing roughly 98% less for the same number of tokens.

So, how can we boost GPT3.5 to perform as good as GPT-4?

Enter, prompt engineering (of course!).

Below are 10 prompt engineering tips, recommended by OpenAI and tested by our customers that can significantly improve your GPT3.5 outputs.

Let’s get to it.

‍

# Prompt Engineering Examples

Have in mind that these were tested on GPT3.5 models, and they might not have the same impact for other models. For instance, Claude 2.1 won’t give you great results with these tips, and you should follow other prompt design methods that are custom made for that model.

‍

1. Separate Instructions from Context

It’s important to add indicators to separate instructions, examples, questions, context, and input data as needed. You can use any characters or text really. OpenAI suggests that you always start with the instruction, and then separate it with the rest of the elements using ### or “”” . See below for how.

For example you can separate it like this:

### Instructions ### Summarize the main ideas for the given text. ### Text ### {input input here}

Interestingly enough, in a recent paper , the “###” indicator didn’t really impact the overall quality of output. However, it did improve the accuracy by more than 50%.

‍

2. Be Direct and Specific

First and foremost, your prompt needs to be very specific.

Clearly state what the model should do rather than what it should avoid. Using affirmatives like “do” instead of “don’t” will give you better results. Use phrases like “Your task is” and “You MUST” to steer them to a better answer.

💪🏻 Strong prompt

### Instructions ### Your task is to summarize the main ideas of the given text. Only use the information that’s provided in the text. ### Text ### {input input here}

❌ Weak prompt

### Instructions ### Summarize the main ideas of the given text. Do not include any personal opinions or additional information that is not present in the text. Text: {input input here}

‍

3. Assign a Role

Always assign a role. If you’re building an AI-powered writing tool, start your prompt with “You’re a content writer…”. You can also test if writing &nbsp;“ You’re an expert content writer ” or “ You’re a world class content writer ” performs better than “You’re a content writer”.

### Instructions ### You’re a content writer , and your task is to summarize the main ideas of the given text. Only use the information that’s provided in the text. ### Text ### {input input here}

‍

4. Tip the Model

Interestingly enough if you add an instruction saying that you’ll tip a certain (and high!) amount of money, the model will generate better answers. This was actually validated with a recent paper.

‍

5. Imitate Style

If you want the LLM output to follow a specific language style, provide an essay or paragraph with that style, something like:

### Instructions ### You’re a content writer, and your task is to summarize the main ideas of the given text. Only use the information that’s provided in the text. Use the same language style based on the provided paragraph below. ### Style ### {input style example here} ### Text ### {input input here}

Providing a sentence that uses the style, instead of explaining the style will improve the quality of the output by more than 80% for GPT3.5/4.

‍

6. Add End-User Info

Are you building a writing assistant for busy founders? Mention it in the prompt that your user is a founder. This information guides the language model to tailor its responses to the end user.

### Instructions ### You’re a content writer, and your task is to summarize the main ideas of the given text, to assist a busy founder in grasping its content efficiently. Only use the information that’s provided in the text. Use the same language style based on the provided paragraph below. ### Style ### {input style example here} ### Text ### {input input here}

‍

7. Provide Format Structure

The models will respond better if they’re shown the exact format that you’d expect them to generate. Try posting the format either before or after the context to see which one gives you better results.

### Instructions ### You’re a content writer, and your task is to summarize the main ideas of the given text, to assist a busy founder in grasping its content efficiently. Only use the information that’s provided in the text. Use the same language style based on the provided paragraph below. Output only the most important conclusions in 4 bulleted points, as shown in the format below. ### Format ### → idea 1 → idea 2 → idea 3 → idea 4 ### Style ### {input style example here} ### Text ### {input input here}

‍

8. Give Examples

If zero-shot doesn’t work, you can try few-shot or chain-of-thought prompting .

Few-shot prompting is a very useful prompting technique where you add a few examples in your prompt to steer the LLM in the right direction. Including a couple of examples that might generalize well for your use case can have high impact on the quality of the answers.

### Instructions ### You’re a content writer, and your task is to summarize the main ideas of the given text, to assist a busy founder in grasping its content efficiently. Only use the information that’s provided in the text. Use the same language style based on the provided paragraph below. Output only the most important conclusions in 4 bulleted points, as shown in the format below. ### Format ### → idea 1 → idea 2 → idea 3 → idea 4 ### Examples ### Text: {text1} Style: {style1} Format: {format1} # Text: {text2} Style: {style2} Format: {format2} ### Style ### {input style example here} ### Text ### {input input here}

If your task involves complex reasoning that requires arithmetic, common sense, or symbolic reasoning, then you can use chain-of-thought-prompting. You can say “think step by step” or provide the exact intermediate steps that the model needs to follow to arrive at the correct answer.

Interestingly enough, the latest research by DeepMind also suggests that if you write “Take a deep breath and work on this problem step-by-step” or something like “”A little bit of arithmetic and a logical approach will help us quickly arrive at the solution to this problem.” will improve GPT 3.5 outputs by more than 12%.

We wrote a whole blog post about it, and if you’re interested to learn more you can read it on this link. Using few-shot chain-of-thought-prompting improves performance by more than 60% with models like GPT-3.5/4.

‍

9. Mitigate Bias

To mitigate bias, you can add the following phrase “Ensure that your answer is unbiased and does not rely on stereotypes”.

‍

10. Use Emotion Prompts

Another study proved that LLMs not only comprehend but can also be augmented by emotional stimuli. They proved that Emotional Prompts outperforms Zero-Shot Chain of thought prompting (think step by step). These work better with large language models. You can add something like " This is very important for my career ” at the end of the prompt and analyze if it will improve the quality of output.

‍

11. Prompt Chaining

If you can't get reliable results from a complex prompt, you may need to split it into multiple prompts. Outputs from earlier prompts can be fed into other ones in a process called Prompt Chaining.

‍

12. No Yapping

When your prompt is generating long-winded responses, just add "No yapping" to the end. This will generate a straightforward answer without unnecessary fluff.

‍

# What makes a good prompt for LLM?

After you’re done writing your prompt, ask yourself the following things:

Are my instructions clear enough? Did I give enough specificity and direction for my task? Did I give enough details about the end-user? Did I provide the language style that I expect to see in the output? For more complex tasks: Did I provide enough examples and reasoning on how to get to the answer quicker? Are my examples diverse enough to capture all expected behaviors?

If you answered with “Yes” on all or most of these, then you’re ready to test your prompt.

Have in mind that writing a good prompt for your AI app is a continuous process and you’ll probably need to iterate a few times until you get a satisfying result.

Also, while these formats are a great starting point, we encourage you to experiment and find the one that best aligns with your specific task.

‍

# What if prompt engineering isn’t getting you the results you want?

Prompt engineering can only take you so far, and you need to account for the complexity and specialization of your use-case.

In cases when you’re dealing with a highly specific task or if you need to provide more context that won’t fit a model’s context window, you might be better off with fine-tuning, retrieval augmented generation (RAG) or use of external tools.

We wrote about RAG, fine-tuning and prompting in a previous post ; go read that one if you’re not sure if prompt engineering is a good solution for you now.

‍

# Do you want to compare and evaluate your prompts?

Vellum’s tooling can help you compare different prompt and model variations via our Prompt Sandbox . You can also run hundreds of test cases to evaluate those prompts using our Evaluation product .

If you want to test more prompts, and include your non-technical team to the process of prompt engineering - we can help.

If you want to see a demo, book a call with us here, or contact us at support@vellum.ai .

‍

# FAQ

## What’s the context window of GPT-3.5-turbo?

There are two variants of the GPT-3.5-Turbo models. Gpt-3.5-turbo-0125 is the flagship model and supports a 16K context window and is optimized for dialog. The GPT-3.5-turbo-instruct is an Instruct model and only supports a 4K context window.

## What is the knowledge cutoff for GPT-3.5-turbo?

GPT-3.5-turbo or the latest model in the family ( Gpt-3.5-turbo-0125) has training data until Sep 2021.

## Whats the pricing for GPT-3.5-turbo-16k?

GPT-3.5-turbo-16K or now called GPT-3.5-turbo-0125 costs $0.0005 / 1K tokens in the input and $0.0015 per 1K tokens in the output.

## Table of Contents

1. Separate instructions from context 2. Be direct, concise and as specific as possible 3. Role assignment 4. Tip the model 5. Imitating style 6. Include end-user information 7. Provide the format structure 8. Give examples 9. Mitigate bias 10. Use emotion prompts 11. Prompt Chaining 12. No Yapping
