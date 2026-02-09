---
title: "Building an AI Agent for SEO Research and Content Generation"
slug: "how-to-build-an-ai-agent-for-seo-research-and-content-generation"
excerpt: "Learn to build an Agent that analyzes keywords, generates articles, and refines content to meet criteria."
metaDescription: "Learn to build an AI Agent that analyzes keywords, generates articles, and refines content until specific criteria are met."
metaTitle: "Building an AI Agent for SEO Research and Content Generation"
publishedAt: "2024-05-29T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build your own SEO agent today."
authors: ["Anita Kirkovska", "Nihala Thanikkal"]
category: "Guides"
tags: ["Workflows"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/68c7bfbe13e2c91eeed4c7a3424ef524ad3c28dc-1500x1032.png"
---

"Let's delve into the groundbreaking advancements of AI in revolutionizing content creation...”

Sounds really artificial and unoriginal, right?

LLMs are really good at writing, but need human assistance to turn their generic take, into original, and useful content.

It’s quite interesting really; LLM models are trained to assist us, but for now, we also need to assist the models with our knowledge and preferences.

How can we best assist LLMs in assisting us?

‍

Simple LLM Interaction

Simply open ChatGPT, or any other LLM-powered chatbot, and try to interact with the model. Didn’t like the first answer you were given? Write “This was a bad answer, improve it by changing X and Y, and add Z”, then the model will take that into account and improve the answer.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8283ba6bd30e0a1f20ee87ce4f2a7f21d0577222-1780x1280.png)

However, writing with your LLM-based chatbot can truly feel like a part-time job; it could take a few, and sometimes many turns for the model to generate high-quality content that you’d actually feel good about. .

Can we make this process easier &amp; better?

‍

Context in Prompts = Better Articles

You can improve the generated output by adding context in your prompt.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/dcceb0ee2ae796b713d816aa01b874b4e2488a4d-2032x1218.png)

Want to generate a LinkedIn post, and you really care about it being written in your style? Paste your previous posts in the prompt, and tell the model to follow that specific style. Want to use your knowledge base? Add it as context, and tell the model to utilize the information in the generations. With window contexts now expanding to 128K for GPT-4o, and even 1M for Gemini 1.5 Pro, you can get very creative; and of course, at a higher cost.

You can dynamically add this context through a vector database search, which will usually return the most relevant content.

Adding context will help, but do we have all the information we need to write a good article?

The short answer is no: we need SEO.

‍

SEO-Optimized Articles Need More Work

Adding context in your prompts is awesome, but if we’re writing SEO-optimized content, we need to think about what to write for the keywords we want to rank for . This is increasingly important, as we've heard many reports of Google delisting AI-generated content that lacks substance.

To actually use AI as your content writing assistant, the process comes down to doing four main tasks:

Keyword research: Identify the ideal keyword; Analyze keyword results; Determine the intent; Analyze the top 5 results to learn what Google is ranking for that keyword;

- Content Architecture: Define audience type;
- Define writing style;
- Outline the format of the article;
- Content generation: Generate content to fit the intent;
- Adapt the content to the writing style &amp; type of audience;
- Add original data that will help the article rank higher for that keyword, compared to the top 5 results;
- Evaluation : Evaluate generated content based on certain criteria;
Now this is getting us somewhere…

However, this process takes a lot of time; It would be really awesome if we could build an “Agent” to do it for us.

Yes, I’m talking about actually building a SEO-driven agent for content writing.

‍

SEO-Driven Agent for Content Writing

To create an SEO-driven content writing agent, we need to develop different roles and actions , for each step of the process outlined above:

SEO Analyst: analyze keyword results, extract article content and intent for top ranked N articles; Researcher: Identify content that can be improved from the top results. If necessary, search the internet for additional data to enhance the article; Writer: Utilize SEO, research data, and basic guidelines (audience, writing style etc..) to write the article; Editor : Review the article based on specific criteria and provide feedback until it meets the requirements.

To be able to build this, and run it autonomously, we imagined this workflow:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/09cc382f8bb6f2a541936a491808c00d796b5f20-2114x1020.png)

In the next sections, I’ll be using an AI development platform, Vellum, to orchestrate every step of the workflow outlined above, that ended up looking like this:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/dc52f3e9d644b491ad2a8881d64be93a003d4491-2000x1008.png)

Now let’s unpack this workflow.

‍

SEO analyst

To create this role, we first needed to provide the agent with internet access to analyze Google's rankings for the targeted keyword.

We can do this easily using the “ API Connector ” in Vellum, and connect to any SERP service online. Then, we built a simple scraper to extract the top-ranking article for that keyword. Ideally, you’d want to analyze the top 5 or more articles, but to keep things simple, we focused on the first one.

Here’s how this part looked like:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ac46ed56843033fee305d4e5b8e4c04b69fe1366-2132x809.png)

‍

SEO Researcher

Then, we ask the “SEO Researcher” to pick out the good and bad parts of this article.

Why do we want to do this?

Our goal is to create an article that is better than the top article (or the top N articles). To achieve this, we need to match the current quality and improve the bad sections. We'll use the bad parts to find original data through SERP searches and rewrite them in our article.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/0dd09f236050715c6b4190911ecc61546c5e1d62-2000x1593.png)

So how exactly will we use these sections?

Good sections: We’ll hand these as context to our “Writer” as a must-write topics; Bad sections: If the "SEO Researcher" identifies some sections that need improvements, it will search the internet for new original data, which will then be passed to the "Writer" as additional context.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/57154aa77cd8aa4569ce7191067c792ab4eeb818-2000x838.png)

‍

Writer

Now let’s look at our “Writer” workflow. This workflow will ingest all of the context that we’ve generated before, like:

Good sections for top ranking articles; Keyword; Intent; Audience; and Newfound data.

This workflow also includes a "Feedback" parameter. We set the default to "no feedback provided," but it will be used to pass feedback from the "Editor" in a downstream step. You can find the prompt that we've used for the "Writer" on this link .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ddca70896923f191332f804ae007517811af9ad5-1133x899.png)

‍

Editor

Finally, our “SEO Analyst”, “SEO Researcher” and “Writer” have worked together to produce an initial article.

But is it good enough?

That’s why we have the “Editor.” In this workflow, the editor is set up as an LLM-based evaluator that follows specific instructions to grade an article. We’ve extracted these instructions from the Google’s official guide on how to write helpful content.

You can find the prompt that we’ve used for this evaluator on this link . Here is how the “Editor” workflow looked like:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5f12d8b35b7a5c4809b14f8d0071f07f0df24708-1306x967.png)

Now that we've created all the roles in our main Agent workflow, we're missing one more step: Retry Logic.

We want the "Editor" to keep checking the blog post until it meets the requirements. To do this, we add a router in the main workflow, setting a condition to pass the article only if the "Editor" gives a "good" or "excellent" rating.

Here's how the loop will work if the score is "bad" or it doesn't meet the requirement:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f7a162397fee263b8754e399e378cf57ee12b73b-1447x678.png)

‍

Results and Conclusions

We’ve ran this workflow with the keyword Prompt Engineering 101 .

The first article that the “Writer” generated was okay-ish. You can read it here: initial draft . Then the “Editor” passed down this feedback , and the “Writer” reworked the initial draft and generated this final article , that got a passing score of “good”.

FYI we never reached the “excellent” score. :)

If you read the final article, please DM me on LinkedIn and let me know if you found it helpful!

## Will we post this on our website?

While we're glad to have powerful tools that replicate part of our SEO research and content generation, we still don't recommend running this on auto-pilot. The final article isn't something we'd post directly on our website, but it automates a big chunk of our work and addresses the blank page problem.

Wiht a few more changes to our prompts and workflows, we're confident that we can get to a very useful Agent that generates a very good first draft. We can then add original and expertise data, and make it 10/10.

This will be significantly easier since we're already halfway there.

‍

Learnings and Future Work

## Observations

Here are some of our observations:

We'd prompt the “Writer” with more directions on what the writing style should be. Currently we only prompted the model that the style is “simple, technical”. Models (GPT4o/Gemini 1.5 Pro) keep on using “delve” :) We'd add error handling after each node, because I faced some errors with LLM providers; When we compare our article to the top two, we see their content starts with engaging examples. Our intro feels generic. Adding examples in the prompt might help.

## Key Learnings

With web scrapers it’s always better to retrieve top N results (for example 5) because some of them could return 404, meaning that you can’t scrape their data and the workflow might break. If you use only the first article as context, the model may overfit the content to that article, increasing the risk of plagiarism. We tested some of the early articles using plagiarism checkers and it scored very high for plagiarism. Our last generated article had only 3% plagiarized text, by setting higher temperature (0.45) and by adding this instruction in the prompt: “You must be creative, and if you're using some data you should mention the source.”, but I expect the model to generate better content if it has access to more articles. Initially, the “Editor” evaluated the Writer's article on a scale of 1 to 10, but we found that LLMs aren't very good at numerical scoring. The evaluator worked better when it rated the article as "good," "bad," or "excellent.” Building a basic Agent workflow could be straightforward or very complex; it all depends how far do you want to go into the rabbit hole. We think we’ve just scratching the surface, and this agent can be improved, and made even more powerful with additional evaluators, prompt engineering and external tools.

## Future work

This is just a very simple iteration on how an SEO-driven Content Writing agent should be built. To create better articles we can expose more tools and data sources to all of the roles in our agent workflows, for example:

The “SEO Analyst” should work with at least 3 articles for a given keyword; The “Editor” can have access to the Internet to give better feedback; The “Writer” can use a Chat Model to get the latest N messages of content and feedback, instead of using a big long context prompt (we used Gemini 1.5 Pro for this one); The “Editor” can have a list of evaluators to check for: Context relevance (using evaluators like Uptrain) Context retrieval (using evaluators like Regex)

- We can have more roles to check for plagiarized content or AI generated content automatically
If you want to build something similar for your own SEO process, let us know and book a demo on this link .

## Table of Contents

Simple LLM Interaction Context In Prompts = Better Articles SEO-Optimized Articles Need More Work SEO-Driven Agent for Content Writing SEO analyst SEO Researcher Writer Editor Results and Conclusions Learnings and Future Work
