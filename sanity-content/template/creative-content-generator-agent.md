---
title: "Creative content generator agent"
slug: "creative-content-generator-agent"
shortDescription: "Give it a URL and a format, and it turns the source into finished creative content."
heroIntroParagraph: "Generate long-form articles from any link "
prompt: "Create an agent that helps with creative writing. I will provide a web url & the desired output. Output could be a blog, poem, Slack message. Once the agent has the web url it should extract the main themes from the url. Then use the main themes to do web research with LLM's native capabilities. Use web research and the document to come up with the output"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-04T00:00:00.000Z"
featured: true
workflowTag: "AI Agents"
industry: "Marketing"
categoryTags: ["Content generation", "AI Agents"]
createdByTeam: "Anita Kirkovska"
integrations: ["Notion", "Web search"]
---

## Prompt

Create an agent that takes a web URL and desired output, extracts key themes, uses {{Web search}} for research, generates the content, and saves the final article in {{Notion}}.

## Content

### Why you need it ‍

Creative writing takes time because you need to understand the source material, research supporting context, and turn those ideas into something engaging. This agent handles the heavy lifting for you. It pulls themes from a web page, researches them further using model capabilities, and generates the final piece in whatever style you request. You give it a URL and an output format, and it turns source material into a polished creative draft that you can publish or send immediately.

### What you need in Vellum

A prompt field for URL input A prompt field for desired output type Logic to extract key ideas from the web content Web research capabilities to add depth and context A generation step to create the final draft in the requested format

## FAQ

### How does the agent use the URL?

It analyzes the content of the page, extracts the main themes, and uses those as the foundation for creative writing.

‍

### What types of creative output can it produce?

Blogs, poems, storytelling pieces, Slack messages, and most freeform writing formats.

‍

### Does it research beyond the link provided?

Yes. It uses the themes from the page as a base and then performs light web research to strengthen the final content.

‍

### How do I control style or tone?

You specify the tone in the input, for example casual, emotional, polished, funny, or professional.

‍

### Can it summarize first before writing?

Yes. You can ask it to summarize the page, extract insights, then write the final output using the summary.

‍
