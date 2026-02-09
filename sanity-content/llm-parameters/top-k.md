---
title: "Top K"
slug: "top-k"
metaDescription: "Learn what top_k (nucleus sampling) is, and how you can use it to create greedy responses, lower reading level or multiple variations."
supportedBy: ["Anthropic", "Google"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

# What is Top K?

Top K is a setting supported by some LLMs; it determines how many of the most likely tokens should be considered when generating a response.

Top K is sometimes stylized as top_k in literature.

# How does Top K work?

LLMs, or Large Language Models, are trained on huge corpuses of text. Consequently, they feature massive dictionaries. However, some words are significantly more likely to appear (e.g. the , you , jump ) than others (e.g. omnivore , innovation , matrimony ).

These words are cataloged as tokens, the fundamental unit of LLMs. Tokenizing large words includes splitting them into smaller strings (e.g. omnivore → omni and vore).

Top K is an integer that defines how many of the most likely tokens should be considered when determining the next token.

To provide an example, imagine a response that has thus far generated the string: On burgers, I like to add . With a Top K of "2", the LLM would only consider the two most likely tokens, such as &nbsp; ketchup (0.2) &nbsp; and mustard (0.1) . There’s a long-tail of other considerations, such as onion(0.05), pickles(0.04), or butter(0.02) , but those would be cropped from consideration.

An alternative to Top K is Top P. While Top K an explicit quantity of tokens, Top P instead denotes a probabilistic sum of the subset, which can significantly vary in token count.

# How do you set the Top K parameter?

Please note, OpenAI only supports Top P and not Top K.

### Anthropic

You can set stop sequences on Anthropic’s Messages API with the optional top_k parameter. top_k strictly accepts an integer value.

### Gemini

You can set Top K on Gemini’s API with the optional topK value. Here topK also accepts an integer value.

# How to experiment with Top K?

By increasing or decreasing Top K, you can see how repetitive or complex responses can get, particularly in their vocabulary and phrasing. With a very low Top K, such as 1 , you’ll get more predictable responses. With a very high Top K, you’ll get a more variance.

Conversely, you can also experiment with Top P, which is similar to Top K, but instead specifies the probabilistic sum of the considered tokens. Top P is more popular than Top K because it accounts for fast and slow drop-offs in probabilities. Because they are both limiters, Top P and Top K shouldn’t be used simultaneously.

# When to use Top K

Top K can be useful for certain scenarios:

Generating Repeat Responses: You can generate identical responses with a Top K of 1 because the LLM will only consider the most likely token. This makes the output deterministic and is known as a greedy response . Managing Reading Level: If you need to produce content at a lower reading level, Top K can assist with that. Generating Variations: If you are looking to generate multiple variations of a response—such as a title of a marketing campaign—you can use drastically different Top K values (e.g. 1 and 10 ) to create bland and “creative” options.
