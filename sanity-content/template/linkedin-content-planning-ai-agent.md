---
title: "LinkedIn Content Planning Agent"
slug: "linkedin-content-planning-ai-agent"
shortDescription: "Create a 30-day Linkedin content plan based on your goals and target audience."
heroIntroParagraph: "Build a 30-day LinkedIn content plan"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/09dc52e9-3c80-4230-a4e0-f007767ac316?releaseTag=LATEST"
workflowId: "09dc52e9-3c80-4230-a4e0-f007767ac316?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-09-02T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Marketing"
categoryTags: ["Content generation"]
createdByTeam: "Nicolas Zeeb"
integrations: ["LinkedIn", "Notion"]
---

## Content

This agentic workflow generates a 30 day LinkedIn content plan based on your content goals, target audience, and business information. It automates the process of generating content ideas, drafting posts, and organizing them into Notion for easy access and management.

‍

### How it Works / How to Build It

Idea Generation Node: This node generates creative LinkedIn content ideas based on the provided business, target audience, and goals. It uses a prompt to instruct the AI model to create a comprehensive content strategy. Post Drafting Node: This node takes the generated content ideas and drafts polished LinkedIn posts. It formats the posts according to LinkedIn best practices, ensuring they are engaging and ready for publication. Notion Agent Node: This agent node integrates with Notion through Composio to store the drafted posts. It takes the finalized content and uploads it to a specified Notion page, allowing for easy management and tracking.

### What You Can Use This For

Marketing teams can streamline their LinkedIn content strategy Social media managers can automate post creation and scheduling Businesses can maintain a consistent online presence with minimal manual effort

### Prerequisites

Vellum account Composio account with Notion or any other word processor connection Clear understanding of your business' content goals and target audience

How to Set It Up

Clone the LinkedIn Content Planner Agent workflow. Input your business name, target audience, and specific content goals in the Inputs section Connect the Idea Generation Node to the Post Drafting Node to ensure the generated ideas flow into the drafting process Connect the Post Drafting Node to the Notion Agent Node Enable Composio's Notion tools to ensure drafted content is input into notion (any other word processor may be used instead of Notion) Connect Notion Agent Node to Final Output

## FAQ

#### Do I need a Notion account to use this? ‍

No. Notion is the example shown, but you can connect any word-processing or documentation tool available through Composio.

#### Can I change the tone or writing style of the posts? ‍

Yes. Update the prompt in the Idea or Drafting nodes to match your voice, tone, structure, and post style.

#### How many posts does it generate? ‍

By default, it creates 30 ideas and drafts 30 posts, but you can edit the number in the prompt or workflow inputs.

#### Can I add my own ideas or edit drafts afterward? ‍

Absolutely. You can overwrite, tweak, or expand any draft before or after it goes into Notion.

#### What if I don’t have clear content goals yet? ‍

The workflow still runs, but results will be more generic. You’ll get better output if you provide specific themes, ICPs, and formats you want.

#### Does this schedule the posts for me? ‍

Not directly. The workflow creates and organizes content. You can add your own scheduling tool or connect an additional node later.

#### What models does it use? ‍

Whatever model you plug into the Idea Generation and Drafting nodes. You can swap models or experiment with different ones.

#### How long does setup take? ‍

Usually a few minutes. Once you clone it, fill the inputs, connect Composio, and run.

### Can I generate multiple 30-day plans per month? ‍

Yes. Just rerun the workflow with new inputs, goals, or audience segments.
