---
title: "Frequency Penalty"
slug: "frequency-penalty"
metaDescription: "Learn how the frequency penalty reduces word repetition. A higher penalty results in fewer repeated words in the generated text."
supportedBy: ["OpenAI"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

# What is Frequency Penalty

The frequency penalty parameter tells the model not to repeat a word that has already been used multiple times in the conversation.

It basically tells the model, “You’ve already used that word a lot—try something else.” The higher the penalty, the less repetitions in the generated text.

# How does it work behind the scenes

The model is always deciding which word to pick next. To make good decision, the model is looking at specific word scoring, or something that we call logits . To change the scoring of a word, we apply penalties.

The frequency penalty specifically targets words that are used repeatedly, lowering their score each time they appear, which makes the model less likely to choose them again.

No penalty: “The dog is barking. The dog is playing. The dog is running.”

With frequency penalty: “The dog is barking. The dog is playing. The cat is running.”

You can apply stricter penalties with the presence penalty, which stops the model from repeating a word after it’s been used just once. Find more information about that specific penalty here.

# How to set this parameter correctly

In the API, this parameter can take any numbers between between -2.0 and 2.0. If a value is not provided it will default to 0 — this means no penalty is applied.

# How to experiment with this parameter

For most use-cases, you can leave this parameter unchanged.

To experiment with this parameter try adjusting the values incrementally to analyze their impact.

Reasonable penalty values range from 0.1 to 1 if you’re just looking to reduce repetition a bit. To strongly suppress it, you can go up to 2, but that might affect the overall quality of the output. Negative values are also an option if you want to encourage more repetition.

# When to use Frequency Penalty

Use the frequency penalty parameter when you’re fine with a bit of repetition but want to stop the model from overusing a specific word.

Penalties like this one are useful in situations where you want your model to be more creative like for summarizing content.

Example: In a news article summary, you’d allow words like “government” or “policy” to appear a few times, but you’d penalize the model if it starts overusing them.
