---
title: "Stop Sequence"
slug: "stop-sequence"
metaDescription: "Learn how to use the stop sequence parameter with OpenAI, Anthropic or Google's models."
supportedBy: ["OpenAI", "Anthropic", "Google"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

# What is a Stop Sequence?

The stop sequence is a feature that prevents a language model from generating more text after a specific string appears. It allows developers to manage response length and curb excessive output without altering the input prompt. Stop sequences make it easy to guarantee concise, controlled responses from models.

# How does it work?

When you provide a stop sequence, the model will generate text as usual, but will halt immediately if it encounters a stop sequence. This keeps responses concise and prevents the model from drifting off into excessive output.

For example, if your stop sequence is &lt;/output&gt; , the model will stop generating text once it produces this tag. You can also set multiple stop sequences (e.g. &lt;/output&gt; , input: ), where the model will halt if any of the sequences are encountered.

# How to set this parameter correctly

### OpenAI

To use stop sequences with the Chat Completions API , you can set the optional stop parameter. stop accepts either a string or string[] .

Alternatively, if you are using OpenAI’s playground UI, you can set stop sequences from the interface itself:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/834afc36d916df97e0a96eab4caab90f7c7221ed-2314x1200.png)

### Anthropic

You can set stop sequences on Anthropic’s Messages API by setting the stop_sequences parameter. stop_sequences only accepts a string[] as an input.

### Gemini

You can set stop sequences on Gemini’s API by setting the stopSequences parameter. stopSequences only accepts a string[] as an input.

# How to experiment with Stop Sequence

For chat completions, you can skip setting this parameter, and model will provide an uninterrupted output.

If you need to limit the output length and know a specific substring that indicates where the response should end, using stop sequences is the way to go.

Notably, you can experiment with instructing the LLM to print the response in a structured format, and use a closing marker of the format as a stop sequence. For example, if your structured format ends with &lt;/output&gt; , then that’s the ideal stop sequence.

# When to use Stop Sequence

Use stop sequence to tackle a few common problems:

1/ Cost management : Because LLMs charge per token, stop sequences help you limit token usage and save costs by limiting the output.

2/ Structured outputs : In structured outputs like XML or JSON, stop sequences stop models from adding unnecessary information. This is particularly helpful for API responses where extra text might break the integration.
