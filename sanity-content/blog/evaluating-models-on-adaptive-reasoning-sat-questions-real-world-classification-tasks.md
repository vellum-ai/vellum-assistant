---
title: "Evaluating models on adaptive reasoning, SAT questions & real-world classification tasks"
slug: "evaluating-models-on-adaptive-reasoning-sat-questions-real-world-classification-tasks"
excerpt: "Evaluating SOTA models if they can really reason "
metaDescription: "Evaluating SOTA models if they can really reason "
metaTitle: "Evaluating models on adaptive reasoning, SAT questions & real-world classification tasks"
publishedAt: "2025-04-14T00:00:00.000Z"
readTime: "5 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
---

# Evaluation Methodology

We evaluated model performance across three datasets:

Adaptive Reasoning (28 examples): Tests how well models adapt to new contexts based on logic puzzles they’ve seen before. Hardest SAT Problems (50 examples): Measures reasoning ability on difficult academic-style questions. Real-World Customer Tickets (100 examples): Assesses classification accuracy on de-identified support tickets (names, phones, and URLs removed).

### Models Tested

We included both open-source and proprietary models. If a model had a specific reasoning or "thinking" mode , we used that variant (e.g. Claude 3.7 Sonnet Thinking instead of the standard Claude 3.7 Sonnet).

### Process

All prompts ran with temperature = 0 . If a model failed to return an answer in &lt;final answer&gt; brackets, we marked it as 0 (or incorrect) Each dataset was evaluated once, no reruns or prompt variation.

### Scoring

We used GPT-4o as an automatic judge with this prompt:

> Your job is to determine whether an answer to a question is correct given the correct answer. If there's anything incorrect about the answer, the answer should be marked as completely incorrect. Question: {{ question }} Correct answer: {{ correct_answer }} Answer to evaluate: the &lt;final answer&gt; part in {{ answer }} Return only the number "1" if the answer is essentially correct and contains no major errors, and the number "0" if the answer contains any significant errors.

Outputs were scored as binary (1 = correct, 0 = incorrect).

### Human Review

After the LLM scoring pass, we manually reviewed the results. This helped catch errors where models overfit or where the auto-judge was too lenient or inconsistent.

‍
