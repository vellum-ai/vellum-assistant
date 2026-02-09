---
title: "Classifying Customer Tickets using Gemini Pro"
slug: "classifying-customer-tickets-using-gemini-pro"
excerpt: "Comparing the performance of Gemini Pro with zero and few shot prompting when classifying customer support tickets"
metaDescription: "Comparing the performance of Gemini Pro with zero and few shot prompting when classifying customer support tickets"
metaTitle: "Classifying Customer Tickets using Gemini Pro"
publishedAt: "2023-12-20T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Compare and evaluate models, and create a production-ready AI app."
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Evaluation"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/8265b37a13172eb4fc08fd10ed88fb0ca33f495b-1107x762.png"
---

To provide more insights on how Gemini Pro does with zero-shot vs few-shot prompting on classifying tasks, we decided to run an experiment.

We used Gemini Pro to classify if customer support ticket has been resolved or not.

Below, we share all our findings and observations.

‍

The Classification task

We picked this task as customer conversations are hard to categorize, due to diverse speaking styles, subtle meanings, and often changing topics or tones.

For instance, if a vendor replies to a bug report by acknowledging that it’s a known issue, the ticket is considered resolved even though the bug isn’t. However, without the proper guidance, the language model may not always recognize this.

Here’s an example of such conversation, that’s marked as resolved:

![A preview of a customer support ticket between a vendor and a customer](https://cdn.sanity.io/images/ghjnhoi4/production/fa8d9405aae5c0fce7614811dc643d02d5094d55-1448x799.png)

## Zero-shot vs few-shot

To assess the model's capabilities, we employed both zero-shot and few-shot techniques. Our goal was to analyze how few-shot prompting influences the outputs produced by Gemini Pro.

‍

Evaluating Gemini Pro

We evaluated Gemini Pro, focusing on its accuracy, recall, and precision. This assessment involved 200 test cases and utilized both zero-shot and few-shot prompting techniques.

#### Results

Gemini Pro with zero-shot prompting had the best F1 score (77.94%) and Recall (94.64%) Gemini Pro with few-shot prompting had the best Accuracy(74%) and Precision (76.79%)

For this particular task, we wanted our model to be more conservative and capture all unresolved tickets, even if it meant tagging some resolved tickets as not resolved. To achieve this, we needed to choose a model with higher precision. In this case, Gemini Pro with few-shot prompting accomplished that for us.

![](https://cdn.sanity.io/images/ghjnhoi4/production/ae0153a4367237ecbf7dce197947ef8cdd43cacf-1154x207.png)

By adding four examples to the prompt for few-shot prompting, we nearly halved the false positives, reducing them by 48% and increasing the precision to 76.79%.

![](https://cdn.sanity.io/images/ghjnhoi4/production/3dc2ccbac1a950617389523aeff3ef614c79e1d2-1155x210.png)

Keep reading for more details on our methodology and the details of the experiment.

‍

Methodology

## Technical setup

For this comparison we used Vellum’s suite of features to manage various stages of the experiment. We used:

Prompt Sandbox: To compare zero-shot and few-shot prompts on the same model Test Suites: To evaluate hundreds of test cases in bulk and measure which cases fail

The dataset we used had 200 test cases. Here is an example:

![Preview of a conversation between a vendor and a customer](https://cdn.sanity.io/images/ghjnhoi4/production/5695b7f6a4dadd1f8bdc6d5cef856ad0363ccdae-700x672.png)

### Prompt engineering &amp; techniques

Before testing the models, we experimented with different prompts to ensure that the model would only output "true" or "false" as answers, without adding any additional explanation.

Here’s a snapshot on how that looked like within Vellum:

![](https://cdn.sanity.io/images/ghjnhoi4/production/cea9d902e5ddd9a90853ff5be002196fa338f1f3-1538x836.png)

Once we were happy with the results, we were prepared to test the model on a larger set of cases.

In the zero-shot prompt we used the last N messages from a customer chat, instructions of what constitutes a resolved conversation, and a description of the expected answer format. In the few-shot case, the prompt had the same components, including examples of resolved conversations.

Note that the {{ messages }} tag is a variable that dynamically passes data within Vellum Prompt Sandboxes.

### Model Information

We ran Gemini Pro with 0 temperature, and 10 token limit, because we wanted to get to a well defined answer.

![A screenshot of the parameter configuration for the models within Vellum](https://cdn.sanity.io/images/ghjnhoi4/production/2d3dc15ad6e227b526efab01ba647876ecaad72b-536x454.png)

### Setting up the test cases

To evaluate the models, we uploaded Pylon's dataset into a Test Suite (which is our unit testing product for LLMs) and selected " Exact Match " as the metric for evaluation.

This evaluation metric verifies if the LLM's output perfectly matches the expected dataset output, considering any extra whitespaces the model might generate. Given that we anticipated either a "true" or "false" output, the evaluation process was straightforward.

Using Test Suites we were able to run all of these test cases at scale.

### Running the evaluation

At this point we had our prompt configurations, and we were ready to run the prompt across our test cases.

We connected the Test Suite with our prompts and initiated the model runs. Here's what the setup looked like during the evaluation process:

![](https://cdn.sanity.io/images/ghjnhoi4/production/0c4192da4b8f763c48e88abf55acb395e025e438-1474x901.png)

### Measuring the results

For this experiment, given that it’s a classification task we compared Gemini Pro on three metrics: accuracy, recall and precision.

Here are the final results that we got:

![](https://cdn.sanity.io/images/ghjnhoi4/production/ae0153a4367237ecbf7dce197947ef8cdd43cacf-1154x207.png)

‍

Conclusions

With this experiment, we learned that Gemini Pro when used with few-shot prompting can improve precision and accuracy, which is very important for classification tasks.

If you’re looking to scale your customer support operations using LLMs and want to evaluate different models and prompt techniques, we can help.

Vellum has the tooling layer to experiment with prompts and models, evaluate their quality, and make changes with confidence once in production.

You can take a look at some of our other use-cases , or book a call to talk with someone from our team, and we’d be happy to assist you.

## Table of Contents

The Classification Task Evaluating Gemini Pro with zero-shot and few-shot prompting Methodology Conclusion and Observations
