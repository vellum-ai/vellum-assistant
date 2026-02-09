---
title: "Tutorial: Setting Up OpenAI Function Calling with Chat Models"
slug: "openai-function-calling-tutorial"
excerpt: "Learn how to use OpenAI function calling in your AI apps to enable reliable, structured outputs."
metaDescription: "Learn how to use OpenAI function calling in your AI apps to enable reliable, structured outputs."
metaTitle: "OpenAI Function Calling Tutorial for Developers"
publishedAt: "2024-04-23T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Build your AI app for production today."
imageAltText: "function calling cover"
authors: ["Anita Kirkovska"]
category: "Guides"
tags: ["Prompt Engineering"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/eada6c48f1beb8f87e9ee216b62532cee3247596-2250x1548.heif"
---

LLMs are great at complex language tasks but often produce unstructured and unpredictable responses, creating challenges for developers who prefer structured data. Extracting info from unstructured text usually involves intricate methods like RegEx or prompt engineering—thus slowing development.

To simplify this, OpenAI introduced function calling to ensure more reliable structured data output from their models.

After reading this tutorial, you'll understand how this feature works and how to implement various function calling techniques with OpenAI's API.

Let's get started.

With function calling you can get consistent structured data from models.

But wait, don't be misled by the name—this feature doesn't actually execute functions on your behalf . Instead, you describe the functions in the API call, and the model learns how to generate the necessary arguments. Once the arguments are generated, you can use them to execute functions in your code.

So now that we’ve cleared that, let’s show you how to set it up.

In this tutorial, we'll show you how to dynamically generate arguments for two arbitrary weather forecast functions. We'll show you how to:

Use the OpenAI's tool parameter to describe your functions; Run the model to generate arguments for one or multiple functions; Use those arguments to execute arbitrary functions in your code;

💡 Please note that this tutorial primarily focuses on configuring the "function calling" feature and does not include instructions for setting up the OpenAI environment. We assume that you already have that covered; if not, please refer to this documentation here . In the sections below, we'll detail each step and share the code we used. If you'd like to run the code while you read, feel free to use this Colab notebook .

First we need to describe our functions in the tools parameter in the OpenAI's Chat Completions API call.

For this example, we'll describe these two functions:

get_current_weather() : Obtains the weather of a given city at the time of request.some text location : A string indicating the city and state (e.g., San Francisco, CA). format : A string enum specifying the temperature unit, either as celsius or fahrenheit.(the model will automatically derrive this from the location)

- get_n_day_weather_forecast() : Returns the weather over n days at a given location. The function includes the parameters location and format, but also includes: num_days : An integer indicating the number of days for the forecast.
This is how our schema looks like:

Before using this schema, we’ll introduce a helper function to make calling the Chat Completions API easier. Our helper function will reduce code repetition, handle errors, and set a default model. In our Collab notebook, we’ve defined the GPT_MODEL as gpt-3.5-turbo-0613. Here's the helper function that we'll continue to use in the following sections:

Now let's see how this schema works, as we pass a system and a user message.

In the example above, we instructed the model not to assume function parameters if they're not provided in the System message. This means the model won't generate a function call unless it has all the necessary parameter details. For instance, if the user message is "What's the weather like today," the model will ask the user for the location before it generates the function call output:

When the model is confident that it has all the required parameters that we defined in our schema, it will finally output the function calling arguments. You can tell a function has been called by observing the finish_reason and function flags in the response.

In our snippet below, we add our response to the messages list, which is then sent as a request to the API again:

Since we’re providing the last missing piece of information, this should be enough information for the model to return a function call with arguments:

Noticed that the model automatically called the function for this user message?

That's because if multiple functions are present, the model will intelligently choose which function call to provide by default. This means that the tool_choice parameter will be set to auto. If there are no functions, the tool_choice parameter will be set to none .

Take a look at the following example, where we change the user's request. For instance, if we changed our prompt to:

The model will know to suggest our get_n_day_weather_forecast() instead :

Forcing a model to choose one function It's important to note that you can also force a model to choose only from one function. Here's how you can do that:

And here's the output that we get from it:

‍

In some cases, you'd like the model to run multiple function calls together, allowing the effects and results of these function calls to be resolved in parallel. This can be done by newer models like gpt-4-1106-preview or gpt-3.5-turbo-1106 .

In our case, let's imagine that a user is asking for the weather in two locations:

This means that the model should output a list of two results, with two different arguments for the same function:

‍

Now that we know how to manipulate our API requests, it’s time to use this output to call our arbitrary functions.

Just to illustrate how this works, we only return an arbitrary text from each function. Then we wrote a function called execute_function_call() that contains if-else conditionals that check the LLM's output and calls the appropriate function based on that response.

Piecing everything together, let's send one more request to the API.&nbsp;

The code below:

Handles a user request Submits the list of messages to the model via the chat_completion_request() Parses the model's response Calls the corresponding function with our defined function execute_function_call() Finally, it prints the results in a structured format

And we get this final output:

‍

In summary, the OpenAI API's function calling feature allows you to describe custom functions that the AI model can intelligently decide to call, generating structured JSON outputs containing the necessary arguments. This helps with more dynamic and interactive applications where the AI can perform specific tasks or retrieve information by invoking these functions based on natural language inputs.&nbsp;

Using this demo, you should be good to implement function calling for your use-case. If you have any troubles feel free to DM me on twitter .

If you want to get these insights in your inbox, subscribe to our newsletter here .

### Additional Resources:

How to Call Functions for Knowledge Retrieval Additional Examples How to Call Functions with Chat Models Chat with PDFs Tutorial OpenAI API Docs OpenAI Cookbook: How to Call Functions with Chat Models

## Table of Contents

What is Function Calling Function Calling Example Describing Functions Generating Function Arguments Parallel Function Calling Calling Functions Conclusion
