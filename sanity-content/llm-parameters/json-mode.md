---
title: "JSON Mode"
slug: "json-mode"
metaDescription: "Learn how to use the JSON_mode parameter to make sure your models always return a valid JSON response to your prompts."
supportedBy: ["OpenAI", "Google"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

# What is JSON_mode

The JSON_mode parameter ensures that the models will always output a valid JSON output as a response to your prompt.

# How does it work

LLMs are really great at handling complex language tasks, but their responses are often unstructured, which can be frustrating for developers who prefer structured data. To extract information from these unstructured outputs you need to use RegEx or prompt engineering — thus slowing the development process.

So, if you enable JSON mode for supported models like OpenAI and Gemini, the models will consistently return the output as a structured JSON object.

# How to set this parameter correctly

### OpenAI

To turn on JSON mode with the Chat Completions or Assistants API you can set the response_format to { "type": "json_object" } . If you are using function calling, JSON mode is always turned on.

Important notes:

When using JSON mode, you must instruct the model to generate JSON (e.g., via a system message). To ensure that’s not the case the API will throw an error if “JSON” isn’t mentioned in the context. JSON mode ensures the output is valid JSON but doesn’t guarantee it matches a specific schema; for that, use Structured Outputs .

### Gemini

To enable your Gemini models to output valid JSON-responses, you can supply a schema to the model:

As text in the prompt. As a structured schema supplied through model configuration.

Read more here.

# How to experiment with this parameter

For chat completions you can skip setting this parameter, and the model will automatically use what’s left from the context length.

However, there are times when you’ll want to limit the length of the output. In those cases, it’s important to have a good way to measure how long the input prompt will be, so you can prevent the output from getting cut off. There are two scenarios for this:

Your prompt is static and you can manually count the tokens needed for the input, and you can easily calculate how much is left for the response; Your prompt is dynamic, and you count the tokens on the fly with libraries like Tiktoken. Read how to do it here .

# When to use JSON mode?

You can use the max_tokens parameter in cases where you’d want to control the length of the output. A

### For chat completions

You can set a lower token count, because you’d want your chatbot to answer in a shorter, conversational manner.

### As a safeguard

You can set a lower token count in cases where you want to prevent the model from continuing its output endlessly, especially if you’re working with high temperature settings that encourage creativity but can lead to verbose responses.

### Optimize processing time

You can also optimize how fast the model responds to a real-time feature in the app by limiting the size of the output.
