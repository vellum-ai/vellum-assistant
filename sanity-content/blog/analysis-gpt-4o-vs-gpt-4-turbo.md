---
title: "Analysis: GPT-4o vs GPT-4 Turbo"
slug: "analysis-gpt-4o-vs-gpt-4-turbo"
excerpt: "Learn how GPT4o compares to GPT-4 Turbo on classification, reasoning and data extraction tasks."
metaDescription: "Learn how GPT4o compares to GPT-4 Turbo on classification, reasoning and data extraction tasks."
metaTitle: "GPT-4o vs GPT-4 Turbo"
publishedAt: "2024-05-14T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build your production-grade AI system today."
authors: ["Akash Sharma", "Sidd Seethepalli", "Anita Kirkovska"]
category: "Model Comparisons"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/266fd6ceda26267c62839debbc42ca42abba36c2-2250x1548.png"
---

This week, OpenAI released GPT-4o, a multi-modal model that’s 2x faster, 50% cheaper and has 5x higher rate limits compared to the latest GPT-4 Turbo release.

It has impressive multi-modal capabilities; chatting with this model is so natural, you might just forget it’s AI ( just like HER).

Like many, we were excited to see the advancements, so we set up an experiment to compare GPT-4o and it's predecessor on three tasks: classification, data extraction and verbal reasoning.

We learn that GPT4o is better than GPT-4 Turbo on all three tasks but:

For complex data extraction tasks, where accuracy is key, both models still fall short of the mark. For classification of customer tickets, GPT4o has the best precision compared to GPT4-Turbo. It still has the best precision when compared to Claude 3 Opus and GPT-4. For reasoning, GPT-4o has improved in tasks like calendar calculations, time and angle calculations, and antonym identification. However, it still struggles with word manipulation, pattern recognition, analogy reasoning, and spatial reasoning.

Read the whole analysis in the sections that follow, and sign up for our newsletter if you want to get these analyses in your inbox!

‍

Approach

The main focus on this analysis is to analyze the improvement of GPT-4o over the latest GPT-4 Turbo model ( gpt-4-turbo-2024-04-09 ).

We look at standard benchmarks, community-ran data, and conduct a set of our own small-scale experiments.

In the next two sections we cover:

Performance comparison (L‍‍a‍‍t‍‍e‍‍n‍‍c‍‍y‍‍,‍‍ ‍‍T‍‍h‍‍r‍‍o‍‍u‍‍g‍‍h‍‍p‍‍u‍‍t‍‍)‍‍ ‍‍ Standard benchmark comparison (example: what is the reported performance for math tasks between GPT-4o vs GPT-4?)

Then, we run small experiments and compare the models on three tasks:

Data extraction Classification Verbal reasoning

You can skip to the section that interests you most using the "Table of Contents" panel on the left or scroll down to explore the full comparison between GPT-4 and GPT-4o.

‍

Performance Comparison

## Latency Comparison

As expected, GPT-4o has lower latency than GPT-4 Turbo:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/6718c88848eadb3a95d37099e7464ee3d2fdabdf-1128x371.png)

### Throughput Comparison

When it comes to throughput, previous GPT models were lagging; the latest GPT-4 Turbo generates only 20 tokens per second. However, GPT-4o has made significant improvements and can produce 109 tokens per second.

Even with this improvement, GPT4o is still not the fastest model available (Llama hosted on Groq generates 280 tokens per second), but its advanced capabilities and reasoning make it a good choice for real-time AI features.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/002cd3cfafd4773d1a3efaa89d2d786a58d1ff00-1128x442.png)

Reported Capabilities

## Standard benchmarks

When new models are released, we learn about their capabilities from benchmark data reported in the technical reports. The image below compares the performance of GPT-4o on standard benchmarks against the top five proprietary models and one open-source model.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7a95516a7e5b1aa1f8babeba5eaf9f267ba9c5d5-3410x2795.png)

Key takeaways from this graph:

On the MMLU, the reasoning capability benchmark, GPT-4o scores 88.7%, a 2.2% improvement compared to GPT-4 Turbo. Reasoning remains a hallmark capability across all GPT models, consistently setting them apart from everyone else. We’ll test the impact from these improvements in the next sections. GPT-4o shows significant improvements in GPQA( biology, physics, and chemistry), MATH, and HumanEvals (coding). On MGSM, the multilingual grade school math benchmark, GPT-4o is showing similar capabilities to the highest capable model Claude 3 Opus. Interestingly, on the DROP dataset, which requires complex reasoning and arithmetic, GPT-4 Turbo outperforms the newer GPT-4o, despite GPT-4o being an enhanced version of the model.

## Elo Leaderboard

Before the GPT-4o was released, the OpenAI team “secretively” added the model in the LMSYS Chatbot Arena as im-also-a-good-gpt2-chatbot. This platform allows you to prompt two anonymous language models, vote on the best response, and then reveal their identities.

GPT-4o is currently the best state-of-the-art model in this leaderboard, scoring an impressive 1310 ELO ranking, which is a significant jump from the top 5 performing models.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/26b4d47a827ae8cfa28f026af44875673992400e-1200x700.png)

Benchmarks and crowdsourced evals matter, but they don’t tell the whole story. To really know how your AI system performs, you must dive deep and evaluate these models for your use-case.

Now, let’s compare these models on three tasks that might be useful for your project.

‍

‍

Task 1: Data extraction

For this task we’ll compare GPT-4 Turbo and GPT-4o’s ability to extract key pieces of information from contracts. Our dataset includes Master Services Agreements (MSAs) between companies and their customers. The contracts vary in length, with some as short as 5 pages and others longer than 50 pages.

In this evaluation we’ll extract a total of 12 fields like Contract Title, Name of Customer, Name of Vendor, details of Termination Clause, whether Force Majeure was present or not etc.

You can check our original prompt and the JSON schema we expected the model to return:

You're a contract reviewer who is working to help review contracts following an Merger & Acquisition deal. Your goal is to analyze the text provided and return key data points, focusing on contract terms, risk, and other characteristics that would be important. You should only use the text provided to return the data. From the provided text, create valid JSON with the schema: { contract_title: string, // the name of the agreement customer: string, // this is the customer signing the agreement vendor: string, // this is the vendor who is supplying the services effective_date: date, // format as m/d/yyyy initial_term: string, // the length of the agreement (ex. 1 year, 5 years, 18 months, etc.) extension_renewal_options: string, // are there extension or renewal options in the contract? automatic_renewal: string, // is this agreement set to automatically renew? termination_clause: string, // the full text in the contract containing information about how to terminate the agreement termination_notice: string, // the number of days that must be given notice before the agreement can be terminated. only include the number. force_majeure: string, // is there a clause for force majeure present in the agreement? force_majeure_pandemic: string, // does force majeure include reference to viral outbreaks, pandemics or epidemic events? assignment_allowed: string, // is there language specifying whether assignment is allowed? answer in only one sentence. jurisdiction: string, // the jurisdiction or governing law for the agreement (ex. Montana, Georgia, New York). if this is a state, only answer with the name of the state. } Contract: """ {{ contract }} """

We collected ground truth data for 10 contracts and used Vellum Evaluations to set up 12 custom metrics. These metrics compared our ground truth data with the LLM's output for each parameter in the JSON generated by the model.Then, we put GPT-4 Turbo and GPT-4 to the test, and here are the results from our evaluation report:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d9dfe98f1733b03158b9fcd6ce66ce380d53612e-2568x894.png)

We extracted 12 pieces of information from the contract:

GPT-4o outperformed GPT-4 Turbo on 6 of the 12 fields, maintained same results on 5 fields and showed degraded performance on one field. From an absolute perspective, both GPT-4 and GPT-4o only identified 60-80% of data correctly in most fields. For a complex data extraction task where accuracy is important both models fall short of the mark. There might be a way to get some better results with advanced prompting techniques like few-shot or chain of thought prompting . As expected, GPT-4o was 50-80% faster on TTFT (time to first token) than GPT-4 Turbo, &nbsp;which further helps GPT-4o in this head to head comparison.

Winner: GPT-4o, due to its better quality and latency compared to GPT-4 Turbo. However, this may still not be the best model for the job. Further evaluation and prompt testing are needed to determine the optimal choice.

‍

Task 2: Classification

In this evaluation, we had both GPT-4o and GPT-4 determine whether a customer support ticket was resolved or not. In our prompt we provided clear instructions of when a customer ticket is closed, and added few-shot examples to help with most difficult cases.

We ran the evaluation to test if the models' outputs matched our ground truth data for 100 labeled test cases, and here are the results:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/392c6a23ac82c5a64691cb8acb6b17711b2f319c-2241x1343.png)

Key takeaways:

GPT-4o showed a 7% improvement compared to GPT-4 Turbo. Interestingly, in an evaluation we ran last December using the same data, GPT-4 Turbo scored 65%, which was higher than today’s results. We’ll definitely need to analyze this further, but one could assume that GPT-4 Turbo is degrading over time. On the other hand, GPT-4 achieved impressive 78% accuracy and Claude 3 Opus reached 72%, both significantly better than GPT-4o.

Accuracy is important but not the only metric to consider, especially in contexts where false positives (incorrectly marking unresolved tickets as resolved) can lead to customer dissatisfaction. Then we calculated the precision, recall and f1 score for these two models, but also added Claude 3 Opus and GPT-4 for good measure:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/097f1830059401a724e02ffb77516ee799f2bf79-1022x386.png)

Key takeaways:

GPT4o : With the highest precision (88.00%), GPT4o is the best choice for avoiding false positives, ensuring that resolved tickets are indeed resolved. GPT-4 turbo and Claude 3 Opus : Both models also have high precision (83.33%), making them good alternatives. However, they have lower recall compared to GPT4o. GPT-4 : Despite having the highest recall (87.50%) and a good F1 score (81.67%), its precision (76.56%) is lower than the others. This might lead to more false positives, which is less desirable in this context.

Winner : GTP-4o demonstrates better precision than all other models. This would be our preferred model for this task. It’s also important to highlight that deciding which model to work with depends on your task and the balance you want to strike between accuracy, precision and recall. It’s also worth mentioning that you can use advanced prompting techniques like CoT , to improve the model outcomes for your specific use-case.

‍

Task 3: Reasoning

While GPT-4 Turbo excels in many reasoning tasks, our previous evaluations showed that it struggled with verbal reasoning questions. According to OpenAI, GPT-4o demonstrates substantial improvements in reasoning tasks compared to GPT-4 Turbo.

Is GPT-4o really better?

To see if the newer model is better, we picked a set of 16 verbal reasoning questions as the cornerstone of the test.

Here is an example riddle and their sources :

💡 Verbal reasoning question: 1. Choose the word that best completes the analogy: Feather is to Bird as Scale is to _______. A) Reptile B) Dog C) Fish D) Plant Answer: Reptile

Below is a screenshot on the initial test we ran in our prompt environment in Vellum:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/78576e96cd1207c709481700d60756221819f48d-1371x888.png)

Now, let’s run the evaluation across all 16 reasoning questions.

In the image below, you can see that GPT-4o shows better reasoning capabilities than its predecessor, achieving 69% accuracy compared to GPT-4 Turbo's 50%.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/868710b9fa065289e495e8446c37248171755a77-1719x1286.png)

From the examples we gave to the model, we can see that GPT-4o is becoming better in the following reasoning tasks:

Calendar Calculations: Accurately identifies when specific dates repeat. Time and Angle Calculations: Precisely calculates angles on a clock. Vocabulary (Antonym Identification): Effectively identifies antonyms and understands word meanings.

And, it still struggles with the following reasoning tasks:

Word Manipulation: Difficulty recognizing and generating meaningful words after letter changes. Pattern Recognition: Struggles with identifying and applying complex rearrangement patterns. Analogy Reasoning: Issues with understanding and matching relational analogies accurately. Spatial Reasoning: Problems visualizing spatial movements and calculating distances.

Winner: GPT4o it's definitely better but it still struggles with some reasoning tasks.

‍

Summary

In this article we looked at standard benchmarks, we ran small scale experiments and looked at independent evaluations. Below is a summary of our findings.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/ed899114bdda60d93508c80221d9c82add455f37-1419x804.png)

### Summary

Data Extraction: GPT-4o shows better performance than GPT-4 Turbo but still falls short in accuracy for complex tasks. Classification: GPT-4o has the highest precision, making it the best choice for avoiding false positives. GPT-4 Turbo shows lower accuracy. Verbal Reasoning: GPT-4o has improved significantly in certain reasoning tasks but still has areas that need improvement. GPT-4 Turbo struggles more in these tasks. Latency: GPT-4o has lower latency, making it faster in response time compared to GPT-4 Turbo. Throughput: GPT-4o can generate tokens much faster, with a throughput of 109 tokens per second compared to GPT-4 Turbo's 20 tokens per second.

# Conclusion

While GPT-4o is a clear winner in terms of quality and latency, it may not be the best model for every task.

Further evaluation and prompt testing are needed to fully harness its capabilities. In the coming weeks, we will expand our comparison to explore GPT-4o's multi-modal capabilities, assessing its performance across text, audio, and image inputs and outputs to provide a comprehensive view of its potential for dynamic and versatile human-computer interactions.

If you're interested to try Vellum and evaluate these models on your tasks, book a demo here.

## Table of Contents

Approach Performance Comparison Reported Capabilities Task 1: Data Extraction Task 2: Classification Task 3: Reasoning Summary
