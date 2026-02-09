---
title: "Great (and not so great) use cases of Large Language Models"
slug: "llm-use-cases"
excerpt: "Despite high potential, LLMs are not a one-size-fits all solution. Choosing the right use case for LLMs is important"
metaDescription: "While LLMs have great potential, they're not suitable for every situation. We detail the good and bad use-cases to help you choose wisely."
metaTitle: "Great (and not so great) use cases of Large Language Models"
publishedAt: "2023-02-27T00:00:00.000Z"
isFeatured: false
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Akash Sharma"]
category: "Guides"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/8265b37a13172eb4fc08fd10ed88fb0ca33f495b-1107x762.png"
---

Large Language Models (LLMs) built by providers like OpenAI, Anthropic, Cohere, Google and now Meta have the potential to create magical user experiences to provide a competitive advantage. We’ve seen companies of all sizes starting to leverage this technology in their products — it’s no longer limited to “AI first” companies.

The applications are everywhere — Github Copilot has improved developer productivity significantly and tools like Jasper and Copy AI help create sales and marketing collateral in a fraction of the time. LLMs can also be used to streamline business processes and lower costs when used for classification and text extraction problems.

While the possibilities seem endless, there are also several use cases where a Large Language Model may not be the right technology. In this post, we share some great (and not so great) use cases of LLMs so you know how you can best use Generative AI in your product.

# Great use cases

### Generating content with specific instructions

LLMs are well suited to generate content with specific instructions, such as Notion AI, Github Copilot or Copy AI. There is usually no correct answer in this generated content and the key to differentiate from competitors is providing a UX that feels natural and intuitive.

Think carefully about how your user may interact with the AI portion of your product, how they can provide sufficient context to get high quality results, and how you will measure how much the user liked the generated content. The companies we’ve seen be successful here are constantly iterating on their prompts and measuring output quality. While iterating on your prompts, be sure to maintain version history and run back tests against historical requests to confirm that the new prompt won’t break any existing behavior!

### Parsing unstructured data

We personally love this use case — LLMs are a new tool in your arsenal to convert the vast amounts of unstructured data that exists into a structured machine readable format for analysis or business processes. We’ve seen use cases for extracting JSON data from invoices, bank statements and government documents (saving countless hours in manual data entry!).

We recommend starting with a zero shot approach and switching to a few shot approach if token limits permit. If this doesn’t result in sufficiently high accuracy, then you should try fine-tuning.

### Classification based on historical training data

Consider using an LLM if you have a business process like classifying emails or support tickets into a predefined category (currently done by humans) — you will save countless hours at a fraction of the cost.

Fine-tuning is the best approach to take here because as you collect more and more correct responses, you can create a pipeline to continuously improve quality, reduce costs and reduce latency. You should periodically re-run fine-tuning jobs as your dataset increases in size to improve performance and potentially decrease cost by switching to a cheaper model.

## Not so great use cases

### Making predictions using tabular data

From what we’ve seen so far, traditional ML models are better suited than LLMs in use cases where predictions need to be made against a large amount of tabular data. An example here would be the fraud detection algorithms used by large financial institutions on each credit card transaction. These algorithms take in a large amount of information (e.g., merchant details, purchase details, historical spending patterns, location) and make a fraud assessment.

For now, LLMs still have trouble creating predictions from primarily numerical data and we suggest using a model more suited to your use case.

### Expecting truthful responses without good prompting or relevant context

LLMs may not always be truthful without good prompting or relevant context. Here’s an example response from an LLM that hasn’t been given enough context

![](https://cdn.sanity.io/images/ghjnhoi4/production/4d1a2cad4b626c0e0b41d4535573a529e5f63349-1716x394.png)

If accuracy of generated content is important for your use case, we suggest good prompt engineering and providing sufficient context in the prompt. If you are looking for answers from a corpus of text (e.g., help center documentation or historical legal cases), you will likely need to perform a semantic search against the corpus and find relevant pieces of context to inject into the prompt. Building the infrastructure for performing this semantic search is a non trivial amount of engineering effort — we will cover best practices as part of a future content piece.

## Conclusion

LLMs have enormous potential for increasing revenue, retention or decreasing costs, but they are not a one-size-fits-all solution. It's important to carefully consider the use case and ensure that LLMs are the right tool for the job.

At Vellum, we work with our customers to identify the highest impact use cases and provide the tools to rapidly deploy them in production while maintaining engineering best practices. We’re excited to learn more about your LLM use cases. Reach out for early access here.
