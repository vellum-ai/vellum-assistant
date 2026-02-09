---
title: "Reddit monitoring agent"
slug: "reddit-monitoring-agent"
shortDescription: "Monitor Reddit for new posts and send summaries to a specified Slack channel."
heroIntroParagraph: "Send me Reddit summaries in Slack"
prompt: "Build an agent that monitors Reddit and sends Slack summaries. It should: Search specified subreddits for recent posts Filter for posts with good engagement (20+ upvotes, 5+ comments) Send a formatted summary to a Slack channel Accept inputs for the target Slack channel and which subreddits to monitor."
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/766e9d0d-f3b3-417b-88b9-f218e3a2c63b?releaseTag=LATEST&condensedNodeView=1&showOpenInVellum=1"
workflowId: "766e9d0d-f3b3-417b-88b9-f218e3a2c63b?releaseTag=LATEST&condensedNodeView=1&showOpenInVellum=1"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-12-02T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Marketing"
createdByTeam: "Anita Kirkovska"
integrations: [" Slack", " Reddit"]
---

## Prompt

Build an agent that monitors selected subreddits on {{Reddit}}, filters high engagement posts, and sends formatted summaries to a chosen {{Slack}} channel.

## Content

### How it Works / How to Build It1

1/ Scheduled Trigger: The workflow starts with the MondayFriday9Am trigger, which activates the workflow every Monday and Friday at 9 AM.

2/ Reddit Monitor Agent: The RedditMonitorAgent node searches specified subreddits for new posts. It filters posts based on the last 7 days and user-defined criteria (e.g., posts with a certain number of upvotes or comments).

3/ Output Node: The Output node formats the results from the Reddit Monitor Agent and sends a summary message to the specified Slack channel.

### How can you use this

1/ Keeping marketing teams updated on trending topics in relevant subreddits.

2/ Monitoring community feedback and discussions for product development teams.

3/ Gathering insights for customer support teams by tracking user inquiries and recommendations.

### Prerequisites

Vellum account Access to Slack for sending messages List of subreddits to monitor

## FAQ

What does this workflow actually do? It checks Reddit on a schedule, pulls new posts that match your filters, and sends short summaries to a Slack channel you choose.

How often does it run? By default, it runs every Monday and Friday at 9 AM. You can change the schedule if you want it more or less often.

Can I pick which subreddits it watches? Yes. You add whatever subreddits you want in the subreddits input when you set it up.

Does it only look at new posts? It looks at posts from the last 7 days and filters them based on the rules you set (like upvotes or comment count).

Can it watch multiple subreddits at once? Yep. You can pass a list of subreddits.

What kind of filters can I set? You can filter by things like minimum upvotes, comment threshold, or other criteria supported in the RedditMonitorAgent node.

Where do the summaries go? They get posted to the Slack channel you define in channel_name .

Can I preview the summaries before they get sent to Slack? Yes. You can test the workflow before deploying it to see what the output looks like.

Do I need any special permissions? You need a Vellum account and Slack access to post messages into a channel.

Does this require any coding? No. You just configure the inputs and deploy the workflow.

Can I change how the Slack message looks? Yes. You can edit the Output node to change formatting or add extra info.

What happens if a subreddit is quiet that week? If there are no matching posts, the workflow can send an empty or “no updates” message, depending on how you format the Output node.

Can I use this for competitive monitoring or trend research? Absolutely. It works well for marketing, product, support, or community teams who need quick snapshots of what’s happening on Reddit.

Can I add more steps, like sending alerts or saving results? Yes. You can expand the workflow with more nodes, like storing results in a database or triggering follow up actions.
