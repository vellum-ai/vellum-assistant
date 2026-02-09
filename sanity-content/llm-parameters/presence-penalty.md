---
title: "Presence Penalty"
slug: "presence-penalty"
metaDescription: "Learn how to use the Presence Penalty parameter to stop the model from repeating words. "
supportedBy: ["OpenAI"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

# What is Presence Penalty

The Presence Penalty parameter prevents the model from repeating a word, even if it’s only been used once. It basically tells the model, “You’ve already used that word once — try something else.”

# How does it work behind the scenes

When the model is deciding what words (or tokens) to pick next, it looks at raw scores called logits . Using these penalties will adjust these scores to avoid repetition.

If a word has been used, the presence penalty immediately lowers its score, making it less likely for the model to choose that word again — even if it’s only been used once.

Here’s a simple example:

No penalty : “The dog is barking. The dog is playing. The dog is running.”

With presence penalty : “The dog is barking. The cat is playing. The rabbit is running.”

In this case, as soon as the word “dog” appears once, the model won’t use it again.

The presence penalty is stricter, so if you want a more flexible approach, you can use the frequency penalty instead.

# How to set this parameter correctly

In the API, this parameter can take any numbers between between -2.0 and 2.0. If a value is not provided it will default to 0 — this means no penalty is applied.

# How to experiment with this parameter

In most cases, you will probably leave this parameter to default to 0. However, if you want to analyze the impact you can start by adjusting the value incrementally (e.g +- 0.1).

Although the range is between -2 and 2, it’s generally recommended to stay between -1 and 1. This helps balance reducing repetition while still allowing the model to generate high-quality outputs.

# When to use Presence Penalty

You can use this parameter to maintain some diversity in the model’s outputs.

For example , with customer support chatbots you want to penalize the model if it’s repeating certain names or phrases — and encourage generation of wider range of helpful answers.
