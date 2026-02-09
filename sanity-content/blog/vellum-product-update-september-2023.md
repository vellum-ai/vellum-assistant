---
title: "Vellum Product Update | September 2023"
slug: "vellum-product-update-september-2023"
excerpt: "September is full of enhancements to Workflows, Security, Support, and more!"
metaDescription: "The product updates for September: enhancements to Workflows, Security, In-app Support, New Help Docs and more."
metaTitle: "Vellum Product Update | September 2023"
publishedAt: "2023-10-02T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Bring your AI app to production today."
authors: ["Noa Flaherty  "]
category: "Product Updates"
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/50d942262514504726a11b315e805c0607348413-1107x762.png"
---

Welcome to another Vellum product update! September brings a wide variety of enhancements across most of Vellum, but had a special focus on Workflows, Security, and Support. Let’s dig in!

‍

## Workflow Sandboxes

We released Workflows last month to help you quickly prototype, deploy, and manage complex chains of LLM calls and the business logic that tie them together. The reception has been amazing and we’ve already been pushed by many of you to make Workflows even more powerful.

### API Nodes

You can now make HTTP requests as part of a Workflow using the new “API Node.” API Nodes are critical for building agents, or for integrating more deeply with your own application. For example, maybe you need fetch data about a user through an authenticated API that you host and then feed the response into a Prompt for use by an LLM.

![](https://cdn.sanity.io/images/ghjnhoi4/production/d9aaa27e698af04e4455123655d1dc5465e82a62-1520x1116.png)

### Renaming Workflow Scenarios

Scenarios are used to define example sets of input variable values that represent the types of inputs you might see in production. You can swap between scenarios to manually test how changes to your Workflow effect its outputs for that Scenario.

You can now rename Scenarios so that you can easily tell which case each Scenario represents.

![](https://cdn.sanity.io/images/ghjnhoi4/production/9ffc03c877ce8fc5ece3084368898c2b0b13098c-562x544.gif)

## Workflow Deployments

You can deploy a Workflow so that you can invoke complex chains of LLM Prompts with a single API call to Vellum, with all the monitoring, versioning, and scaling benefits that you’re used to with Vellum Prompt Deployments.

Now, we’re bringing more and more features from Prompt Deployments to Workflow Deployments.

### Save Execution as Scenario

Once you’ve integrated a Workflow Deployment with your application, Vellum will track all requests made against it – their inputs, outputs, latency, etc. Now, if you spot an edge case, you can save it as a Scenario to your Workflow Sandbox so that you can iterate on your Workflow until it outputs what you expect.

![](https://cdn.sanity.io/images/ghjnhoi4/production/6303fa56aba7c9c2a84b318782782191f7954d76-864x481.gif)

### Supplying Actuals

Just like you can “supply actuals” to a Prompt Deployment to capture end-user feedback, you can now do the same for Workflow Deployments. You’re able to supply a quality score (between 0.0 - 1.0) for each Output within the Workflow, as well as a “Desired Output” representing what you wish the output had been.

You can do this either manually from the UI.

![](https://cdn.sanity.io/images/ghjnhoi4/production/64c850633f6b5930abb3b5d642fd8d6334da662a-1296x721.gif)

Or programmatically via the API (which is particularly useful for capturing feedback directly from your end users).

![](https://cdn.sanity.io/images/ghjnhoi4/production/0eccbfb013be0b4a34f490a208357133d5068a8b-2808x1100.png)

### Displaying Errors

You can now see when errors occur in production on individual Workflow Deployment Executions, as well as a description of the error.

![](https://cdn.sanity.io/images/ghjnhoi4/production/a732f026d5c18b4f4380d4e1f011943f432b5e3e-3456x1926.png)

## Security

Security and data privacy is treated with the utmost of care within Vellum. We continue to invest in making Vellum an enterprise-ready solution for building AI applications.

### Secret Management + Auth Headers

You can now define “Secrets” in one central place in Vellum (e.g. API keys, service tokens, etc.) and then dynamically reference them elsewhere in Vellum. These secret values are securely encrypted and stored using Google Cloud Platform’s KMS service .

![](https://cdn.sanity.io/images/ghjnhoi4/production/8a3975614dbc9efacb682b3890f2d751757ab209-1202x958.png)

You might then use these Secrets as authorization header values in API Nodes within Workflows and in Webhook Evaluation Metrics within Test Suites .

![](https://cdn.sanity.io/images/ghjnhoi4/production/5f612e7d17c4a6ea43396a649315268e1bdb9971-3456x1926.png)

### HMAC Signatures

You can now provide a secret token that can be used to verify that outgoing API requests are in fact coming from Vellum. This is especially helpful if you’re standing up endpoints for use by API Nodes or Webhook Evaluation Metrics and want to ensure no one is trying to maliciously impersonate Vellum.

![](https://cdn.sanity.io/images/ghjnhoi4/production/b8628bc4b4b5dbae855be17c2518ea355a099d15-1392x416.png)

## Deployments

Prompt Deployments got some UI/UX love this month.

### Filters, Column Visibility, and Refresh

There are now visual indicators when the Completions table of a Prompt Deployment has hidden columns and/or has filters applied. As a result, it’s also easy to update column visibility and filter criteria. You can also now refresh the table’s data with the new “Refresh” button.

![](https://cdn.sanity.io/images/ghjnhoi4/production/98c0aac00f7973f31e86ff2f4f2659270ee89589-2868x1834.png)

### Prevent Deletion of Deployments Used in Workflows

Every Prompt Node within a Workflow Deployment is backed by a Prompt Deployment. We now show a warning when you try to delete a Prompt Deployment that’s still in use by a Workflow Deployment.

![](https://cdn.sanity.io/images/ghjnhoi4/production/d24681b98b028fac3aee9a759dcd600737d3f12a-888x654.png)

## API

### Retrieve Document Index

There is now an officially supported API (in Beta state) to retrieve a Document Index by it’s ID/Name. This is useful if you’re programmatically creating indexes and want to check to see if one already exists prior to creating it.

![](https://cdn.sanity.io/images/ghjnhoi4/production/89b887e8e806f8e682173acff83664594486759f-3456x1926.png)

## Support

We’ve made a big push this past month to get the help you need while using Vellum. We can’t claim it’s perfect yet, so please always feel free to reach out to us on Slack, Discord, or email us at support@vellum.ai !

### New Help Docs

We have a brand new Help Docs site thanks to our friends at Fern . You can expect richer documentation and tighter integration with our API Docs over the coming months.

![](https://cdn.sanity.io/images/ghjnhoi4/production/5043d398c592ee61c9e82361ff260ba426c83e53-3456x1926.png)

### In-App Support via Pylon

You can now chat with us directly within the Vellum application thanks to our friends at Pylon . If you’re a Vellum customer with a shared Slack channel with us, then these messages will sync and carry over to the channel.

![](https://cdn.sanity.io/images/ghjnhoi4/production/4c1f292314ffbb5968d16707842a921bb3b466d0-864x481.gif)

## Conclusion

And that’s a wrap! Thanks as always to all of you who help push us to build a better product and become a better business every month.

We have exciting plans for October – stayed tuned!

‍
