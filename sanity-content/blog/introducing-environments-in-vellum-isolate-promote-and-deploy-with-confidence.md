---
title: "Introducing Environments in Vellum: Isolate, Promote, and Deploy with Confidence"
slug: "introducing-environments-in-vellum-isolate-promote-and-deploy-with-confidence"
excerpt: "A first-class way to manage your work across Development, Staging, and Production."
metaDescription: "A first-class way to manage your work across Development, Staging, and Production."
metaTitle: "Introducing Environments in Vellum: Isolate, Promote, and Deploy with Confidence"
publishedAt: "2025-07-17T00:00:00.000Z"
readTime: "6 min"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
authors: ["Akash Sharma"]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/6a3a7d2f4de34f1e1a6621abd8daa72b1f8dbe94-1920x1080.png"
---

Today, we’re launching Environments: a first-class concept in Vellum for managing your work across development, staging, and production with proper isolation and full control.

If you’ve dealt with multiple deployments, managed several release tags, struggled with API rate limits from non production traffic or wondered which version of a workflow is live in production, this one’s for you.

Now, you can clearly separate environments, promote releases between them, and manage your deployments well so your team moves fast and ships with confidence.

👉 Try Environments now

## How this Works

## 1. Start with Your Environments

Every Vellum Workspace starts with a Production environment. You can create more — Development , QA , Staging , etc. — depending on your team’s setup.

Each environment is isolated. It gets its own:

API keys Documents Release history Monitoring data

A new environment can be created in the Workspace settings page:

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d3dfd44129dedda097fc97332c1a098ef26282dc-3020x1632.png)

## 2. Set environment-scoped API keys

Each environment gets its own API keys, this is especially useful for secrets, which need different values in development, staging or production.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d3332127c60984a7403a61fb83b296a9a68681c7-1912x924.png)

## 3. Deploy to the right Environment

When you’re ready to deploy a Prompt or Workflow, you can choose which environment(s) to deploy to. Just select one or more targets, hit deploy, and a new Release gets cut in each environment you selected.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/5fa64ea374576cf5eaf41720251d5368d6a5cd88-1982x1280.png)

## 4. Promote a Release Between Environments

Finished testing in Development? You can promote a release directly to Staging or Production and no need to manually redeploy. Just click “Promote” on a Release and select which Environment it should be promoted to.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/e43fa537a0f2aef5a756d95f899f619621ece012-3456x1916.png)

### 5. Use Environment Variables to Customize Behavior

Environments also support Environment Variables , which let you define constants or reference secrets that differ by environment. Think: a unique FIRECRAWL_API_KEY in dev vs prod

You define your variables once, and then reference them in any workflow node. Vellum will automatically resolve the right value based on which environment is executing the workflow.

This allows your AI system’s logic to stay the same, while using a different API key based on which Environment it's running in.

![__wf_reserved_inherit](https://cdn.sanity.io/images/ghjnhoi4/production/d297e45fb2d231ccd09a3c228152198c2df96273-2980x1718.png)

## Best Practices

Here’s how we recommend setting up your environment strategy:

Development : for building and iterating Staging : for QA and stakeholder testing Production : for live, user-facing workflows

### API Key Management

Use separate API keys for each environment Regularly rotate API keys, especially for production environments Never use production API keys in development or testing

### Release Management

Use descriptive Release Tags that follow semantic versioning Test thoroughly in development and staging before promoting to production Maintain clear documentation of what changes are included in each release Use the LATEST tag for most deployments to simplify your process

### Monitoring and Observability

Monitor costs and usage patterns separately across environments Use Environment-specific webhooks and integrations Set up alerts for production environments

## What’s Next

This is just the beginning. We’ll soon be adding:

Model provider API keys per environment CI/CD-friendly tooling for automated promotions and releases

We’re excited to help you scale your AI development with the same rigor and structure as any other production system.

## Try it Now

Environments are now generally available to all Vellum users. You now have proper isolation, a clear audit trail and safer testing &amp; rollout. It’s the easiest way to bring structure to your AI deployment process.

👉 Sign up or log in to get started

Have feedback or want to show us your setup? We’d love to hear from you.
