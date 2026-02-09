---
title: "Vellum Product Update | November 2024"
slug: "vellum-product-update-november-2024"
excerpt: "Something special is coming, plus new models and quality of life improvements"
metaDescription: "Something special is coming, plus new models and quality of life improvements"
metaTitle: "Vellum Product Update | November 2024"
publishedAt: "2024-12-02T00:00:00.000Z"
readTime: "3 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/1dcb3c94f2741337d43cf4a6a4537961eb83a383-716x493.png"
---

Why are LLMs the best guests at holiday parties?

They always arrive promptly

(sorry, that was written by a human… we’re still fine-tuning him)

‍

# Something New Is Coming

💡 Before we dive in… next month we’ll launch a novel Agent &amp; Workflow development framework. If you want maximum control over your AI system, easier debugging and &nbsp;confidence shipping to production — join the waitlist here .

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d4012434f62e0ca949330e8ce6698e63ee648390-994x320.png)

‍

Play your favorite Christmas jingle, sit back, and enjoy our November product updates. If you're more visual, check out the video below:

‍

# Updated Prompt Sandbox UI

## Prompt Editor

Previously, “Input Variables” and “Scenarios” were separate panels, which added friction to experimenting quickly. We’ve consolidated these panels and polished our Prompt Sandbox page as a whole, to make them easier to use and nicer to look at.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/fdecea45c933ab28b3562a2bfc6f9e133d836f5d-2530x1542.png)

## Comparison Mode

We’ve made updating variable names easier. Previously, if you wanted to rename your variables, you had to scroll to the top of the page— which is far from where you interact with them. Now, you can rename them inline where you set their values.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/7d1ec22001e37578337b8558362926681784642d-3456x1918.png)

## Chat Mode

Previously, it was difficult to view longer outputs on a single screen (or you needed to purchase a bigger monitor). Now, you can now resize any panel and all UI elements look consistent across all modes.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/8f565816f40d04270902167f314f5f4c38d5067d-3456x1918.png)

# New APIs

### Prompt / Workflow Deployment Release Tags and Historical Items

You can now retrieve Release Tags associated with Prompt and Workflow Deployments, as well as Historical Deployment items . Combined, these can be useful for ensuring smooth cutovers between your application code and your deployments when deployment interfaces change.

## Audio Inputs for gpt-4o-audio-preview

OpenAI recently launched gpt-4o-audio-preview , which can process audio inputs and understand pronunciation, intonation, etc., as well as produce audio outputs. We now support these capabilities through an API. Read more here .

# New Models

• AWS Nova Models (Micro, Lite, Pro) • LLaMa 3.1 405b via SambaNova (speed 200 t/s) • Support for GPT-4o (2024-11-20) • Claude Haiku 3.5 10-22-2024

# Quality of Life Updates

## Real-time Workflow Execution Monitoring

Previously, if you wanted to view the live-execution traces of Workflows, you needed to refresh the Execution Details page to see updates. Now, you can see live-updates in the UI while the Workflow runs!

## Increased Test Case Concurrency

We've increased the max concurrency for Test Case runs from 12 to 36, significantly speeding up your testing cycles and allowing for more efficient use of resources.

## Copy &amp; Paste Workflow Nodes Improvements

Previously, it wasn’t possible to copy &amp; paste Workflow Nodes while their outputs from previous executions were showing. We’ve fixed this, and improved the overall reliability of copy/paste functionality within Workflows, Subworkflows, and across Workflow Sandboxes.

We’ve also removed the “Copy of” title text on Nodes when they’re pasted— making it easier to experiment and refactor Workflows to increase their maintainability.

## Persisted Sort Order for Index Pages

Previously, if you left an Index/Browse page and came back to it, you’d have to set your preferred sort orders upon return. Now, we remember this for you, making it easier find your Prompts, Workflows, and Documents when you start a new working session.

## Easier Evaluation Test Case CSV Uploads

Previously, if your CSV column headers didn’t *exactly* match what your Vellum interface expected, you’d have to open your CSV, update your headers, re-attempt uploading, rinse &amp; repeat. Now, we allow optional headers, so you can upload CSVs of Test Cases with extra fields or missing fields and start running your Evals faster. We also now allow semicolon delimiters.

## Full Height for Displaying Subworkflows

Previously, Subworkflow viewing UIs weren’t using the full height of their containers. Now, you can more easily navigate, iterate, and improve on Workflows leveraging Deployed Subworkflows.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/05fd8f479bf0317ee2ed99bc0d84bc4ffef07eba-6886x2224.png)

‍

‍

‍

That’s all for now! Stay warm this December, be present with loved ones, and celebrate all the wonderful things you’ve accomplished over the past year. We’ll see you… next year 🤯
