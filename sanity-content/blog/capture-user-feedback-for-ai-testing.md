---
title: "Capture User Feedback for AI Testing"
slug: "capture-user-feedback-for-ai-testing"
excerpt: "Capture and use end-user feedback as ground truth data to improve your AI system’s accuracy."
metaDescription: "Capture and use end-user feedback as ground truth data to improve your AI system’s accuracy."
metaTitle: "Capture User Feedback for AI Testing"
publishedAt: "2025-01-01T00:00:00.000Z"
readTime: "3 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/3c0fa55803c22c3ae74032ebe9e1a2d0a5579c65-716x493.png"
---

We’re excited to introduce a powerful new feature that allows you to capture end-user feedback on your AI system and use it as ground truth for your test cases. This gives you the ability to continuously refine your AI outputs, improving accuracy and ensuring your system delivers more reliable results over time.

Here’s how it works.

# Capture feedback as test cases

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/59862d5b7841930039f77738f68301c60e135483-1838x622.png)

magine you have a RAG chatbot that answers questions about your product's trust center and privacy policies. You've already set up a test suite to evaluate the chatbot’s performance across several important metrics, such as semantic similarity. This dimension measures how closely the chatbot’s responses align with the correct answers.

Once your system is live, you can collect end-user feedback and label it as actuals—either from users directly or from internal labeling data. These actuals represent what the correct response should have been, based on real-world interactions.

# How it works

In Vellum you can easily flag the incorrect response, mark it as a test case example and add it in your evaluation suite. Here’s a quick demo on how that works:

‍

With the new test case saved, you can go to your evaluation set and run the evaluation again to see how closely the chatbot’s output matches the updated ground truth.

If needed, you can tweak your prompts or workflows and rerun the evaluation until the system’s output aligns closely with the expected response. This process helps improve accuracy and ensures that the chatbot continuously gets closer to the correct answers.

# Why This Matters

By incorporating end-user feedback into your testing cycle, you're creating a continuous improvement loop for your AI system.

This allows for faster iteration, more accurate outputs, and an overall improvement in AI system performance. Essentially, you're ensuring that your AI stays aligned with real-world expectations, while making it easier to spot and fix issues quickly.

Vellum is designed to support every stage of your AI development cycle — book a call with one of our AI experts to set up your evaluation.
