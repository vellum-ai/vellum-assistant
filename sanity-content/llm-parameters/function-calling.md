---
title: "Function Calling"
slug: "function-calling"
metaDescription: "Learn how to set up and use Function Calling to have the model generate arguments for your functions. This helps automate tasks and seamlessly integrate the model with your tools and applications."
supportedBy: ["OpenAI", "Anthropic", "Google"]
cover: "https://cdn.sanity.io/images/ghjnhoi4/production/3e7699256e88eaf0b5649c7f5f9da06dbcd03e44-1090x750.png"
---

## What is Function Calling?

With Function Calling (Tools), you describe functions that you want the model to generate arguments for. This allows you to directly connect the model’s responses to your tools and functions, making it easier to automate tasks and integrate the model into your application.

## How does it work?

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/2e75b34d62e6fb485829853b0de168581bbd4177-1943x408.png)

Don’t be mislead by the name of this feature — Function Calling will not automatically “call” your functions, but it only describes the functions for which the model should generate arguments for.

You can use Function Calling with the OpenAI , Anthropic , and Gemini &nbsp;models(Check the hyperlinks for each provider to get to their API references).

While we won’t dive into the specific setup for each API, we’ll cover main capabilities and provide some high-level examples to guide you.

## Steps to enable function calling

Pick a function in your code that a model should generate arguments for Describe the function to your model using names, parameters and schemas

Then based on the query, the model can be prompted or decide on its own whether to use a function calling definition (tool). If so, the model gathers all required parameters by asking follow-up questions to the user Once it captures all parameters, it will output a JSON object

Then you can pass the mode’s response (JSON object) to run any tools, functions in your code.

Basically, Function calling allows you to define functions in your API call, have the model generate arguments using user queries, and then use those arguments to execute the functions in your application.

## How to customize the function calling definition

There are situations where you may want to control whether the model executes specific function calling definitions.

OpenAI, Claude and Gemini models all provide customization of their function calling feature. In each of their API requests, you can define the following “control” options:

Parallel function calling: The models can generate multiple function calls in a single response, allowing parallel execution. This is useful for tasks like checking the weather in multiple locations at once. To handle these, you process each function call separately and return results for each. Tool Selection: You can configure how the model uses the tools. There are three options: auto : The model decides whether to call any provided tools (default) required/any : The model must call at least one tool, but it chooses which. specific_tool: The model must choose a specific tool.

Read how to set these up in the API references for each of the model providers: OpenAI , Anthropic , and Gemini .

## Function Calling with Strict JSON schema (Structured Outputs)

OpenAI allows you to use their newest feature Structured Outputs with function calling, by adding the strict: true parameter in your call.

So how it works?

By default, these models do their best to map arguments in their responses, even without strict enforcement of the schema.

However, OpenAI has introduced Structured Outputs with Function Calling, which ensure that model outputs for function calls will exactly match your provided schema, offering more reliability.

Read more about Structured Outputs here.

## When to use Function Calling (Examples)

### Fetching Data

Imagine building a travel assistant.

When the user asks for flight status, the AI uses function calling to identify parameters like flight number, date, or passenger name. It can then send these parameters to a flight information system to retrieve live status data, such as delays or gate changes, which it uses to respond.

### Taking Actions

An AI assistant for a restaurant can handle table reservations.

The AI listens for a user’s request to book a table. It uses function calling to connect to the restaurant’s reservation system, sending parameters like the time, date, and party size.

It retrieves availability details and returns a confirmation, updating both the user and the restaurant’s system.

### Performing Computations

Function calling can collect details and run functions that perform some calculations.

For example, the user provides loan details (amount, interest rate, and term), which the AI parses. Using function calling, it passes these parameters to a function designed to perform the financial calculations. The computed interest amount is returned and presented to the user.

### Building Workflows

Function calling allows you to create rich, automated workflows.

For example, you can use it to extract and categorize clauses from a contract. The model outputs this data based on a pre-defined schema used in your function calling setup. Since the extracted data follows the required schema, you can automate storing it in your document management system, ensuring compatibility with the system’s expected format.

### Updating your UI

You can use function calling with structured outputs to adjust the UI.

For example, a home automation assistant can adjust the thermostat interface based on user input. When a user says, “Lower the temperature to 68°F,” the AI can output the parameters needed for an upstream function that updates the thermostat UI and changes the temperature in real time.
