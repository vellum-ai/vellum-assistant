---
title: "GPT-4o Mini v/s Claude 3 Haiku v/s GPT-3.5 Turbo: A Comparison"
slug: "gpt-4o-mini-v-s-claude-3-haiku-v-s-gpt-3-5-turbo-a-comparison"
excerpt: "A comparison between the latest low cost, low latency models"
metaDescription: "A comparison between the latest low cost, low latency models on three different tasks: classification, data extraction and reasoning."
metaTitle: "GPT-4o Mini vs Claude 3 Haiku vs GPT-3.5 Turbo"
publishedAt: "2024-07-19T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Compare these models for your use-case"
authors: ["Anita Kirkovska", "Akash Sharma"]
category: "Model Comparisons"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/8617c1389e9399d4f54f981a1d22eb547dd00cac-806x468.png"
---

New day, new model! Today, OpenAI released “GPT-4o Mini”, their latest cost-efficient small model. At 128k tokens the context window is 8x larger than GPT-3.5 Turbo. OpenAI is suggesting developers use GPT-4o Mini where they would have previously used GPT-3.5 Turbo as this model is multimodal, performs better on benchmarks and is more than 60% cheaper.

We see a pattern emerging of model providers announcing models across “weight classes”, Anthropic has 3 different Claude 3 models and OpenAI has 2 GPT-4o models. In this comparison article, we’ll answer the following questions:

Does GPT-4o Mini really perform better than GPT-3.5 Turbo for my tasks? What’s the best small model currently on the market? Claude 3 Haiku or an OpenAI model?

To compare GPT-4o Mini, GPT-3.5 Turbo and Claude 3 Haiku on specific tasks, we evaluated them across 3 different tasks:

Data extraction from legal contracts Customer tickets classification Verbal reasoning

For these specific tasks, we learned that:

Data Extraction : GPT-4o Mini performs worse than GPT-3.5 Turbo and Claude 3 Haiku, sometimes missing the mark entirely. All models don’t have high enough quality for this task (only 60-70% accuracy) Classification : Highest precision for GPT-4o (88.89%), making it the best choice to avoid False Positives. Balanced F1 Score between GPT-4o Mini &amp; GPT-3.5 Turbo Verbal Reasoning : GPT-4o Mini outperforms the other models. It doesn’t do well on numerical questions but performs well on relationship / language specific ones.

Read the whole analysis in the sections that follow, and sign up for our newsletter if you want to get these analyses in your inbox!

‍

Our Approach

We look at standard benchmarks, community-ran data, and conduct a set of our own small-scale experiments.

In the next few sections we cover:

Cost comparison Performance comparison (L‍‍a‍‍t‍‍e‍‍n‍‍c‍‍y‍‍,‍‍ ‍‍T‍‍h‍‍r‍‍o‍‍u‍‍g‍‍h‍‍p‍‍u‍‍t‍‍)‍‍ ‍‍ Standard benchmark comparison (example: what is the reported performance for math tasks between GPT-4o mini vs GPT-3.5 vs Claude 3 Haiku?) Three evaluation experiments (data extraction, classification and math reasoning)

You can skip to the section that interests you most using the "Table of Contents" panel on the left or scroll down to explore the full comparison between the models.

‍

Cost Comparison

OpenAI has remained true to its word of continuously pushing costs down and making AI accessible to a large number of people.

Winner = GPT-4o Mini

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f8f6bb7ff4d03c111b4fc8990758b780bd158e6a-2000x1241.png)

‍

Performance Comparison

### Latency Comparison

Latency, or time to first token, is an important metric to minimize because it helps reduce the perception of how “slow” the model is to respond. The data below measure p50 latency across a dataset and you can see GPT-3.5 Turbo is marginally faster than the other models.

However, latency can be impacted by the load on the API and size of the prompt. Given the low latency of these models overall and the data here only showing median we’d call this a tie between the 3 models.

Result = TIE

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/31d25ebd7b494a4e68cd968798af5b16a5568548-2000x1238.png)

### Throughput Comparison

Throughput, on the other hand, is the number of tokens a model can generate per second once it generates the first token. GPT-4o Mini’s throughput is significantly higher than other models in the market, so for long form output generation (e.g., writing a job description) GPT-4o’s completions will likely be the fastest despite a slower time to first token

Winner = GPT-4o Mini

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/06553d30891e12ac24615379eb28df9f3c1c1f22-2000x1244.png)

Reported Capabilities

### Standard benchmarks

As part of GPT-4o Mini’s launch blog, OpenAI released details about the model’s performance on standard benchmarks:

MMLU (Massive Multitask Language Understanding) GPQA (Graduate Level Google-Proof Q&amp;A) DROP (Discrete Reasoning Over Paragraphs) MGSM (Multilingual Grade School Math) MATH (General Mathematics) HumanEval (Code Generation) MMMU (Massive Multi-discipline Multimodal Understanding and Reasoning) MathVista (Visual Math Reasoning)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/1478d956da4fc173105cf482f1477f6cfcec9ac9-2000x1122.png)

Here are the main takeaways from this data:

GPT-4o Mini performs 2nd best on most benchmarks after GPT-4o. The biggest performance improvements compared to GPT-3.5 Turbo seem to be in Mathematics (MATH and MGSM), which was a common issue with prior generations of LLMs. GPT-4o has newer capabilities in visual math reasoning because of multimodality, this capability was not present in GPT-3.5 Turbo

### ELO Leaderboard

For chat completions, evaluated by the public ELO leaderboard , GPT-4o outranks GPT-4 Turbo:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/0401fe4e03976e52a502491915458ef4606e866e-1200x1195.jpg)

Benchmarks and crowdsourced evals matter, but they don’t tell the whole story. To really know how your AI system performs, you must dive deep and evaluate these models for your use-case.

Now, let’s compare these models on three tasks that might be useful for your project.

‍

Task 1: Data Extraction

For this task, we’ll compare GPT-4o Mini, GPT-3.5 Turbo &amp; Claude 3 Haiku on their ability to extract key pieces of information from legal contracts. Our dataset includes Master Services Agreements (MSAs) between companies and their customers. The contracts vary in length, with some as short as 5 pages and others longer than 50 pages.

In this evaluation we’ll extract a total of 12 fields like Contract Title, Name of Customer, Name of Vendor, details of Termination Clause, whether Force Majeure was present or not etc.

You can check our original prompt and the JSON schema we expected the model to return:

You're a contract reviewer who is working to help review contracts following an Merger & Acquisition deal. Your goal is to analyze the text provided and return key data points, focusing on contract terms, risk, and other characteristics that would be important. You should only use the text provided to return the data. From the provided text, create valid JSON with the schema: { contract_title: string, // the name of the agreement customer: string, // this is the customer signing the agreement vendor: string, // this is the vendor who is supplying the services effective_date: date, // format as m/d/yyyy initial_term: string, // the length of the agreement (ex. 1 year, 5 years, 18 months, etc.) extension_renewal_options: string, // are there extension or renewal options in the contract? automatic_renewal: string, // is this agreement set to automatically renew? termination_clause: string, // the full text in the contract containing information about how to terminate the agreement termination_notice: string, // the number of days that must be given notice before the agreement can be terminated. only include the number. force_majeure: string, // is there a clause for force majeure present in the agreement? force_majeure_pandemic: string, // does force majeure include reference to viral outbreaks, pandemics or epidemic events? assignment_allowed: string, // is there language specifying whether assignment is allowed? answer in only one sentence. jurisdiction: string, // the jurisdiction or governing law for the agreement (ex. Montana, Georgia, New York). if this is a state, only answer with the name of the state. } Contract: """ {{ contract }} """

‍ We gathered ground truth data for 10 contracts and used Vellum Evaluations to create 14 custom metrics. These metrics compared our ground truth data with the LLM's output for each parameter in the JSON generated by the model.

Then, we tested GPT-4o Mini, GPT-3.5 Turbo &amp; Claude 3 Haiku using Vellum’s Evaluation suite:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/64f555bf9aa39623f355d089f534eb0730fa0dc0-2000x1000.png)

Then we compared how well each model extracted the correct parameters, by looking at the absolute and relative mean values for each entity, using Evaluation Reports:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/0347f24d01be37e2d1d370326ef30fea4af1ffcb-2000x992.png)

Here’s what we found across the 14 fields:

7 fields had equal performance across models. For the other 7 fields results were a mixed bag, in most cases there was one model that did worse and the other two were tied at the top: GPT-4o Mini was the worst performing model in 4 fields, GPT-3.5 Turbo was the worst in 2 fields. Claude 3 Haiku was the worst on 1 field.

- For one of the fields, GPT-4o Mini completely missed the mark and had 20% accuracy compared to 70% for GPT-3.5 Turbo &amp; Claude 3 Haiku
- From an absolute perspective, this weight class of models don’t provide the desired quality for accurate data extraction. Most fields only had 60-70% accuracy while some were far lower. For a complex data extraction task where accuracy is important pick a more powerful model like GPT-4o or Claude 3.5 Sonnet and use advanced prompting techniques like few-shot or chain of thought prompting .
Winner: Claude 3 Haiku beats GPT-3.5 Turbo marginally, but all models fall short of the mark for data extraction task.

‍

Task 2: Classification

In this evaluation, we had GPT-3.5 Turbo, Claude 3 Haiku and GPT-4o Mini determine whether a customer support ticket was resolved or not. In our prompt we provided clear instructions of when a customer ticket is closed, and added few-shot examples to help with most difficult cases.

We ran the evaluation to test if the models' outputs matched our ground truth data for 100 labeled test cases.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/f78e4aa4892752170c9495a7e4e898a22617c235-2000x1171.png)

In the Evaluation Report below you can see how all models compare to GPT-4o Mini:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/029b41afd26e458fbba9f2ea45bb0ba405628ee7-2000x741.png)

We can see from the report that:

Accuracy Comparison: GPT-4o Mini (0.72) does better than Claude 3 Haiku (0.61) and GPT-3.5 Turbo (0.66). Improvements: Claude 3 Haiku and GPT-3.5 Turbo outperform GPT-4o Mini on 11 completions Regressions: Claude 3 Haiku and GPT-3.5 Turbo underperform GPT-4o Mini on 22 and 17 completions respectively, adding further evidence that GPT-4o Mini does better at this classification task

Accuracy is important but not the only metric to consider, especially in contexts where false positives (incorrectly marking unresolved tickets as resolved) can lead to customer dissatisfaction.

So, we calculated the precision, recall and F1 score for these models:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9dbde0f62afcacd422cf16cace1777219b533ca7-978x582.png)

Key takeaways:

GPT-4o Mini has the highest precision at 88.89%, indicating it is the best at avoiding false positives. This means when GPT-4o Mini classifies a ticket as resolved, it is more likely to be accurate, thus reducing the chance of incorrectly marking unresolved tickets as resolved. Both GPT-4o Mini and GPT-3.5 Turbo have higher F1 scores compared to Claude 3 Haiku

Winner: TIE between GPT-4o Mini and GPT-3.5 Turbo, choice based on preference between Type 1 and Type 2 errors

Note: Keep in mind that prompting techniques can help increase these numbers. We can analyze the misclassified scenarios, and use those insights to prompt the model better. When it comes to AI development it’s all about iterative improvements.

‍

Task 3: Reasoning

The benchmarks released by OpenAI says that GPT-4o Mini is the best model in its weight class on reasoning tasks. Let’s see how it does on our evals. We selected 16 verbal reasoning questions to compare the two. Here is an example riddle:

💡 Verbal reasoning question: 1. Choose the word that best completes the analogy: Feather is to Bird as Scale is to _______. A) Reptile B) Dog C) Fish D) Plant Answer: Reptile

Below is a screenshot on the initial test we ran in our prompt environment in Vellum:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/495178b2c0afb5e7656e91e78eab12da6174b121-2000x1232.png)

Now, let’s run the evaluation across all 16 reasoning questions:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/23b3419340e31a67751c21fa12fcaba8140fb21f-2000x1065.png)

From the image above we can see that:

GPT-4o Mini outperforms the other models with 50% accuracy, versus 44% for GPT-3.5 Turbo and 19% for Claude 3 Haiku. Claude 3 Haiku is often unable to complete its output, better prompt engineering would likely resolve this issue GPT-4o Mini doesn’t do well on numerical questions but performs well on relationship / language specific ones.

Winner: GPT-4o Mini

‍

Summary

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5814ae886abc2b4c7236120659d73b5fad22371a-1526x882.png)

‍

# Conclusion

While GPT-4o Mini leads in most areas, further evaluation and prompt testing on your specific use case is essential to fully understand the capabilities of these models. Building production-ready AI systems requires careful trade-offs, good prompt curation, and iterative evaluation.

Want to compare these models on your tasks &amp; test cases? Vellum can help! Book a demo here.

‍

Source for throughput &amp; latency: artificialanalysis.ai

Source for standard benchmarks: https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/

## Table of Contents

Our Approach Cost Comparison Performance Comparison Reported Capabilities Task 1: Data extraction Task 2: Classification Task 3: Reasoning Summary
