---
title: "How to connect a Vellum AI Workflow with your Lovable app"
slug: "how-to-connect-a-vellum-ai-workflow-to-a-lovable-app"
excerpt: "Build a functional chatbot using Vellum AI Workflows and Lovable with just a few prompts."
metaDescription: "Build a functional chatbot using Vellum AI Workflows and Lovable with just a few prompts."
metaTitle: "How to Connect a Vellum AI Workflow to a Lovable App"
publishedAt: "2025-05-13T00:00:00.000Z"
readTime: "6 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Anita Kirkovska"]
category: "Guides"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/6403b79c60feed167f61cdbe398cf59ba1bd66c2-1165x627.png"
---

In this guide, I’ll walk you through how I connected an AI chatbot built in Vellum to a UI created in Lovable .

Since Lovable doesn’t let you hit external APIs directly, this tutorial relies on prompts, Supabase, and a bit of trial and error.

## What we’ll build

We’re going to create a warranty claims chatbot UI in Lovable that sends messages to a backend AI workflow hosted in Vellum. Here’s what that setup looks like under the hood:

User enters a message in the Lovable chat UI The message is sent to a Supabase Edge Function , which holds the API key That function calls the Vellum workflow endpoint , sending the user input The response is returned and displayed back in the UI

‍

## Quick demo

‍

## 👷🏻 Vellum

Before jumping into Lovable, you need to grab a few things from Vellum. You’ll need a working workflow that’s ready to receive user input and return AI-generated responses.

### 1. A Deployed Workflow &amp; cURL

In Vellum’s Workflow Builder , define your inputs and logic. Once you’re happy with your workflow click “Deploy”. This will take you to the Deployments tab, where Vellum gives you a curl command for the API endpoint you want to hit.

The one that I used for this example was the “ Execute Workflow Stream Endpoint” . Copy the curl statement and save it somewhere.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/4b41320185135bfa35d69bd89225849ceb7ab278-2048x1048.webp)

### 2. Grab the API Docs

For the endpoint you're using, make sure to have the corresponding Vellum API documentation on hand. Lovable will need this as context to understand what kind of response structure to expect from the API endpoint that you want to connect with the app.

For my example, since I’m using the “Execute Workflow Stream Endpoint” I copied the text from this documentation page: link

👉🏼 Important: Make sure to expand all parameters in the API documentation so that you can provide Lovable everything it needs for that API call.

‍

### 3. Create your Vellum API key

From the main nav, go to More → API Keys.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/32628bcef058d1c2da3499168f2cf7995bbd29b6-2048x1070.webp)

Find the Vellum API section at the end of the page. From there, click on the “Create a new API key” button. In the popup, add a label, select the environment (Development is fine) and click “Create”.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5d2ed9ab53a61162ea2609e6d0cac312967cebdd-1370x858.png)

Once you do that, the app will show you the API key that you can only copy once. Make sure you store that somewhere because we’ll need to store it in Lovable.

And that’s everything that you need from Vellum’s side:

A curl snippet from your AI workflow A Documentation page for the endpoint we want to connect A Vellum API Key

Now let’s take a look at what you can do with Lovable, which could be reliant so much on prompts, so don’t expect a straightforward process. But we have a few tips for you before we go into Lovable:

‍

## ❤️ Lovable

Lovable creates code based on prompts (directions) you provide. prompt-driven. You chat with it, give it screenshots or instructions, and it builds your app step by step. Before we go into the details I want to stress a few important best practices that you should follow:

Start with a mockup. Ask Lovable to build a visual layout first before adding functionality. Break down your prompts. Don’t try to give it everything at once, split instructions into smaller chunks. Secure your API secrets. Use Supabase with Edge Functions to handle them safely. Always use the “Chat” option to plan. Start by discussing what you want to build. Lovable can scan your current code and suggest a logical approach. This approach works well, because the agent will have some time to plan and think about the approach. To enable this “Chat” mode, simply click on the “Chat” option in the input field. To go back to “execution” mode, simply deselect the “Chat” option.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/82695f76b3b3cb19c679e8631fc80d49e47dbb73-1088x254.png)

Ok, now let’s see what I did in Lovable, and what should work for your use-case as well.

### 1. Generate a mockup

I started by taking a screenshot from ChatGPT and asked Lovable to turn it into a mockup for my warranty claims chatbot.

👉🏼 This was my prompt: "I wanna create a mockup for a warranty claims chatbot that looks like the image above."

Lovable built a layout with a header, conversation history window, and an input box, a solid starting point for any chatbot.

### 2. Use Supabase to Securely Store the API Key

Since Lovable doesn’t have a secure place to store secrets, you’ll need to route all external calls through Supabase Edge Functions . Thankfully, Lovable integrates directly with Supabase.

In Lovable:

Click the Supabase icon on the sidebar Create a new project (Lovable takes care of the setup for you)

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/cb1fb428a56ec9c5a56ffe15ab8be209d6d35268-270x106.png)

Once that’s done, open the Chat tab in Lovable and ask:

👉🏼 Prompt: “I have an API endpoint from my AI workflow that I want to connect with this mockup. I realize I need to store the API secret somewhere on Supabase, what should I do?”

Lovable will scan your project and propose a plan to:

Create an edge function Store the Vellum API key securely Send requests to your workflow

Click “Implement the plan” and paste your Vellum API key when prompted. I got this response once I did everything from the above:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8674d9823f371afacebad81d2dbda17aac5ab87b-1080x918.png)

After I added the API keys, Lovable started creating the edge function for me that will store the API endpoint in Supabase:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/cf94fe178ff053e4613f138ad4bd517fd36e5f3b-1072x626.png)

### 3. Connect the Chat UI to the Vellum API

Now, it’s time to show Lovable your curl statement and ask it to connect the mockup with your workflow, using the API secret you just stored in Supabase.

Before jumping into implementation, I provided Lovable more context on what I want to do, the curl statement and the API documentation, using the “Chat” option. Here’s how that looked it:

👉 Now let's try to connect to my API endpoint to execute my workflow that's created in Vellum. I'll send you a curl and some documentation about this API endpoint. Tell me if you know what to do next based on this information and how you plan to do it. Here's the documentation: {here I pasted the whole documentation page from Vellum.} Here's the curl: # create your API key here: https://app.vellum.ai/api-keys#keys curl --request POST \ --url "https://predict.vellum.ai/v1/execute-workflow" \ --header "Content-Type: application/json" \ --header "X-API-KEY: $VELLUM_API_KEY" \ --data '{ "workflow_deployment_name": "acme-electronics-warranty-claim-bot", "release_tag": "LATEST", "inputs": [ { "type": "CHAT_HISTORY", "name": "chat_history", "value": [{ "role": "USER", "text": "&lt;example-user-text&gt;" }] } ] }'

Then Lovable told me that it understands what I want to do and suggested this plan:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/48bd31d7e0aa77ca1fcd3359f34ca4a97e2d4cf2-1072x1418.png)

The plan looked solid, so I told Lovable to implement it:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/9868055ca976d115a4214fe9e64213e3f756ddb1-1070x1364.png)

### 4. Troubleshoot and Test the Integration with Lovable

My first test didn’t work. The UI showed:

“I processed your request but couldn't generate a proper response.”

So I asked Lovable:

“Can you check what’s going wrong with the API response?”

Lovable reviewed the edge function, noticed that the response from Vellum wasn’t being parsed correctly, and patched it to extract the text field correctly from the stream.

And that’s it! If you have any questions feel free to ping me on slack or over email anita@vellum.ai .
