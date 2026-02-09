---
title: "What is Required for a Reliable AI System?"
slug: "what-is-required-to-build-an-ai-system"
excerpt: "Learn the key strategies and tools for building production-ready AI systems."
metaDescription: "Learn the key strategies and tools for building production-ready AI systems."
metaTitle: "What is required to build an AI system?"
publishedAt: "2024-06-04T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build a production-ready AI system"
authors: ["Akash Sharma"]
category: "Guides"
tags: ["Deployments"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/c8333d926e57a511a381f74d54237d7a1d8cdb1e-1107x762.png"
---

Having worked with thousands of companies building AI systems in production, we’ve identified some common patterns in companies who are able to take their flashy demos / proof of concepts to production use and get ongoing business value.

Today our platform powers more than 20M API requests in production per month and enables the development of AI products for iconic brands like Redfin (read more about Ask Redfin here ).

This guide is meant for product &amp; engineering leaders who are trying to make sense of the AI development process and the necessary tooling to effectively integrate AI.

Whether these tools are built in-house or purchased from a vendor, we see 4 distinct categories emerge:

Experimentation: Pick the best architecture and prompts for your task across all open and closed source models. Evaluation: Make concrete progress in LLM app development via pre-defined qualitative or quantitative evaluation metrics. Lifecycle Management: Ensure your application continues to perform well in production and make changes with confidence. Security &amp; Collaboration: Have multiple people in your company work on your AI features with the right data security in place.

In the next sections, we'll give you easy-to-follow advice on the tools and methods you need for each step.

‍

Experimentation

LLMs are non-deterministic, unpredictable, and getting them right requires a lot of trial and error. Having a framework that allows for rapid experimentation between various approaches is essential to build the best quality product.

Here are some items to consider while you’re experimenting:

Prompt Engineering: Quickly iterate on various prompting techniques like zero shot, few shot , chain of thought or tree of thought prompting to see which one works best for your task at hand. Tweak some LLM parameters like top_p , top_k , temperature , stop_sequence , frequency &amp; presence penalty to control how the LLM behaves and generates responses. Multi-step architectures: Often times one prompt may not be enough to consistently achieve the task at hand. For instance, for a support chatbot, a common pattern we see is having an LLM powered intent classification upfront before having specialized downstream prompts to handle the intents. Make sure your experimentation isn’t limited by a single prompt! RAG pipelines: Retrieval Augmented Generation (or RAG) is a common architecture choice when your application needs to refer to context from a knowledge base. Your retrieval results can vary based on choice of embedding model, filtering, chunking &amp; retrieval strategies so remember to test across these options. Model provider agnostic: Every month we see new foundation models being announced by providers like OpenAI, Anthropic, Mistral, Google &amp; Meta. Our leaderboard shows that Anthropic and Google’s latest models currently outperform GPT-4 on general benchmarks. Your experimentation framework should be model provider agnostic so you can pick the best model for the task at hand. Version control your experimentation: Experimentation is more science than art. Keep track of every iteration you try so you can pick the best elements from each attempt as you make improvements. (Bonus) Bring people beyond software engineers into prompt engineering: Prompts are written in natural language, you will save valuable software engineering time if your framework allows for experimentation by non technical team members.

Given the non-deterministic nature of Large Language Models, we always recommend having a test driven development framework while experimenting with LLMs.

After completing this step, you will have a clear understanding of which projects are:

Realistic and achievable Likely to have the greatest positive effect The most favorable to develop based on current circumstances and resources. ‍

Evaluation

Knowing the goalpost for your experimentation is key, and that’s where Evaluation comes in.

At this stage, you’re done with your experiments, and you want to optimize for quality, cost, latency &amp; privacy considerations while building the application.

Here’s what to have in mind while in this phase:

Cost: Most models charge per token and pricing is available online directly with the model providers. Remember to keep context window and response length in check if you’re looking to optimize cost. Latency: Different models have different latency; we had published a report about this a few months ago: latency comparison . Since then Claude 3 Haiku has been released which has really low latency given its quality. Pick the right set of models for your task and consider time to first token as your key metric if streaming is acceptable for your end user experience. Privacy: Some models may be entirely “out-of-scope” for you if you don’t have the right legal provisions set up with the model providers or if the data must live on-premise. Quality: Ultimately, quality is usually the most important dimension because developers don’t put apps in production if they don’t meet the quality threshold. The rest of this section covers successful strategies to measure the quality of your LLM output.

After you’re done optimizing, you’re ready to test whether your AI system is going to work reliably against your test cases.

### Using ground truth data

First check if you have "ground truth" data for your use-case. This is the answer you'd expect the LLM to provide. Usually this data can come from either manually labeling test cases or looking at historical data you have access to.

For example: Let’s say you want to automatically pull out information from PDF files. You might already have some examples of the data you need, which were previously entered by your operations team. You can use these examples as labeled data to train your automation system.

When you have labeled data, you can compare the model generated *response* with the target response . Consider these metrics:

Exact match: Useful for classification tasks. Does model generated response exactly match target response? Regex match: Also useful for classification tasks. Does model generated response match the regex pattern in target response? Semantic similarity: Useful for Q&amp;A or generative responses where there is a correct answer. How semantically similar is model generated response to target response? JSON key-value match: Useful for data extraction tasks. Do the key value pairs match target response?

### No ground truth data, no problem

If you don't have labeled data, there are some other strategies to evaluate model responses:

LLM based eval: Have a downstream prompts or set of prompts evaluate the model response. This can be very custom, choose whatever evaluation prompts you believe are helpful for your task. Code eval: Use code to do your evaluation --&gt; Is the response less than 100 characters? Is the response valid HTML? Just like LLM based eval, this can also be very custom.

Both LLM based eval and code eval can be also used to evaluate RAG pipelines.

💡 Now we won't end this section without some bonus metrics 💡

JSON specific metrics: Useful for data extraction tasks. Is this valid JSON? Does the schema match target schema? Evaluation post execution: Useful for SQL or code generation tasks. Run the completed generation and see if the response was correct or not. Human evaluation: When domain specific expertise (e.g., legal, healthcare) is needed to evaluate the response quality, having human evaluators grade the output would be your best bet. RAG evaluation: There are metrics to evaluate the quality of your retrieval and generation, RAGAS provides a helpful starting point to choose the metrics that matter for your use case.

While evaluating your prompt or multi-step chain, we always recommend coming up with a basket of metrics based on the task at hand and test across models and prompts to meet your quality criteria.

If you have a high bar for accuracy and low risk tolerance in case something goes wrong, make sure to have a large number of test cases in your test bank.

The tooling you use for experimentation should be flexible enough to allow you to compose metrics of your choice.

‍

‍

Lifecycle Management

Once your AI application is in production, you’ll inevitably need to make changes. A new model might come out, or your system may encounter edge cases. Safely making changes once in production is critical, and companies should have appropriate tooling for it.

### Measuring performance in production

Here are the common actions performed by the most successful companies we work with:

Log all the calls you make to the LLM provider: inputs, outputs, exact provider payload, latency. If your application uses chained prompts, track the inputs, outputs and latency at each step for full traceability. This raw data is used in a visualization tool for better observability: number of tokens over time, latency over time, errors over time etc. Use your creativity and make charts to track whatever trends are most important to you. Set up alerts. If latency exceeds a set limit, your system should alert you rather than the user. The metrics used for your unit testing (e.g., relevance, helpfulness, bias) can be run on production traffic to measure quality of the application in production. Any time edge cases are encountered in production they should be added to your unit test bank to make your next release even higher quality. If possible, capture implicit or explicit user feedback for each completion. Explicit user feedback is collected when your users respond with something like a 👍 or 👎 in your UI when interacting with the LLM output. Implicit feedback is based on how users react to the output generated by the LLM. For example, if you generate a first draft of en email for a user and they send it without making edits, that’s likely a good response. Support stateful API calls. While building more advanced systems like agents, you’d benefit if you correctly maintain state between API calls. By retaining state across multiple calls, the application can efficiently manage user context, adapt its behavior based on past interactions, and provide timely updates or transactional operations. Custom memory management strategies are used when needs are more nuanced. Caching, retry logic, fallback logic. OpenAI may be down, your application might hit rate limits, make sure there’s a backup so your end user experience isn’t affected. Cache responses so you can save tokens.

### Making changes in production

While making changes to your AI application (either single prompt or multi-prompt):

Maintain good version control and version history. Pin to stable versions in production and use staging environments for testing where possible. Maintain the ability to quickly revert back to an old version. Replay historical requests with your new prompt / prompt chain and make sure nothing breaks. Regression testing is vital to give you peace of mind that your AI application won’t degrade.

If software never had to change, things would be easy! That’s rarely the case.

Good tooling for Lifecycle Management is necessary as you iterate, evolve, and make changes. Get the basics right and you’ll sleep more easily.

‍

Security and Collaboration

All these prompts, test cases and production traffic need to be stored in a secure environment. They often contain trade secrets and sensitive customer data. In the development process we also see companies wanting collaboration between technical and non technical stakeholders (e.g., subject matter experts). Engineers often determine the testing methodology and decide when something is ready for production while subject matter experts can help with prompt engineering &amp; evaluation to share the development load.

Here are some items to consider:

Audit logs: Keep track of who made what changes to your prompts both during experimentation &amp; in production. This will come in handy if there’s a need to investigate an incident down the road. Virtual Private Cloud environment: If using a SaaS vendor, consider a VPC installation for higher security. By using a VPC, you can ensure that your application and data are protected from unauthorized access, as it allows you to define and manage your own network configurations, including subnets, routing tables, and access control policies. Additionally, a VPC can improve performance and reliability by enabling you to deploy resources in a dedicated, private environment, reducing the risk of interference from other tenants. Role Based Access control: You may not want your non technical stakeholders to update production traffic, that’s where Role Based Access Control comes in. You can ensure that users have access only to the prompts, test suites and deployments necessary for their role, enhancing both security and operational efficiency. Multiplayer mode: Building LLM features is a collaborative process. You want people to leave comments on each other’s work, modify each other’s prompts for faster decision making and a more cohesive development process. This makes the team more productive and helps avoid changes being overwritten.

‍

Need help getting started?

All this may sound daunting, but luckily, you don’t have to build it all yourself.

Vellum is a production-grade AI development platform that gives you the tools and best practices needed without needing to build complex internal tooling.

Reach out to me at akash@vellum.ai or book a demo if you’d like to learn more.

## Table of Contents

Experimentation Evaluation Lifecycle Managementk Security and Collaboration Try Vellum
