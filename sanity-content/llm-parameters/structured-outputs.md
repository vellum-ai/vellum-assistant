---
title: "Structured Outputs"
slug: "structured-outputs"
metaDescription: "Learn how to set up and use Structured Outputs to ensure your model generates valid JSON that aligns with a provided JSON Schema."
supportedBy: ["OpenAI", "Google"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

# What are Structured Outputs

‍ Structured Outputs is a feature that ensures that the model will output a valid JSON object that adheres to a provided JSON Schema.

# How does it work

Initially everyone was amazed of using LLMs to generate text outputs. But as these llm generations became natively integrated with code within more complex AI systems — developers needed more structured outputs to enable upstream tasks without complex data transformations.

JSON mode was the first feature that enabled valid JSON objects as outputs… but they didn’t adhere to specific schema, so the models still made mistakes and hallucinated.

Enter Structured Outputs.

Now, developers can include a JSON schema in addition to the prompt, guiding the model to generate a JSON object that precisely matches the specified schema.

# How to use Structured Outputs with Gemini

You can force the model to follow a given JSON schema with the Gemini 1.5 Pro, and Gemini 1.5 Flash models JSON mode feature. To do that simply specify the schema for the JSON response in the &nbsp; response_schema property of your model configuration.

You can find more information here. ‍

# How to use Structured Outputs with OpenAI

Structured Outputs are available in the latest OpenAI models, starting with GPT-4o , including gpt-4o-mini-2024-07-18 and later, and gpt-4o-2024-08-06 and later, while older models like gpt-4-turbo use JSON mode instead.

Structured Outputs is available in two forms in the OpenAI API: When using function calling and when using a json_schema response format.

But when should you use one or the other? To put it simply:

If you want to connect your model’s output to tools, functions, data in your app, use function calling. If you want to structure the model’s output and pass that to the user, then use a json_schema response format.

In this guide we’ll focus on using Structured Outputs as response_format with the OpenAI response_format parameter, and you can find more examples of using it with function calling on this link.

# Using Structured Outputs as response_format

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9776e1e71d27ef8a0e8bcfab185bb278d1abb083-1337x408.png)

To use Structured Outputs in the response_format follow these steps:

1. Define your JSON schema in the prompt

2. Add your JSON schema in the API call like so:

3. Parse the generated structured data into your app

### Supported JSON Schema types for OpenAI

‍ The following types are supported for Structured Outputs:

String Number Boolean Integer Object Array Enum anyOf

### Important things to mention

The first request with a new schema may have extra latency as the API processes it, but future requests with the same schema won’t experience this delay. To use Structured Outputs, all fields or function parameters must be specified as required . The root level object of a schema must be an object, and not use anyOf . A schema may have up to 100 object properties total, with up to 5 levels of nesting. Outputs will be produced in the same order as the ordering of keys in the schema. You can use definitions to define subschemas which are referenced throughout your schema. Recursive schemas are supported — Sample recursive schema using # to indicate root recursion.

# When to use Structured Outputs

Let’s look at some real-world examples where using Structured Outputs as a final response can be useful.

### Generate Valid HTML for UI Generation

One really interesting way to use Structured Outputs is to generate valid HTML code.

Wait, how is this possible?

Well, you can create valid HTML code by defining the schema as a recursive data structure, which breaks down the HTML elements into a tree-like format.

In this structure, each element (like &lt;div&gt;, &lt;p&gt;, etc.) can contain nested elements, and you apply constraints (like enums) to limit the values of specific attributes or elements. For example, you could use an enum to restrict the values for an HTML tag like &lt;button&gt; to only allow valid button types like “submit,” “reset,” or “button.”

Here’s an example output:

By using Structured Inputs, the model generates this JSON object, which can then be directly parsed and displayed in your UI for the user.

### Step by Step Outputs (Chain of Thought)

Another great use of structured outputs is when you want the model to work through a problem and output each step as parameters in a valid JSON object. Let’s imagine that you want the model to guide a user to solve a specific math problem.

With Structured Outputs and a defined JSON schema, the model can output intermediate steps, allowing you to parse them in your UI and guide users through solving the problem with clear, structured data.

The output can look something like this:

Extracting data from PDF One very frequent use of JSON outputs is when you want to extract data from your files. With Structured Data extraction the model should be more reliable to follow your schema and extract the right data from your PDFs.

Let’s say you want to extract key information from a contract or invoice stored in a PDF. You provide this JSON Schema:

And the model will then output:

Moderating Responses You can define a JSON schema to classify inputs into multiple categories that you’re moderating for. Let’s say you are moderating for offensive language and spam. You might use the following schema:

The model will output a valid JSON object based on the schema, like this:

Tips and Best Practices To improve model generations, here are some tips for good JSON schema definitions:

Use clear, intuitive names for your keys. Provide descriptive titles and explanations for important keys. Test different structures by running evaluations (evals) to find what works best for your specific use case.

‍
