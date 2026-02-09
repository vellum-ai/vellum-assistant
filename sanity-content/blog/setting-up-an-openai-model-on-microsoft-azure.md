---
title: "Setting Up an OpenAI Model on Microsoft Azure"
slug: "setting-up-an-openai-model-on-microsoft-azure"
excerpt: "Step-by-step instructions for configuring OpenAI on Azure"
metaDescription: "Step-by-step instructions for configuring OpenAI on Azure, and how to get the Azure OpenAI endpoint to use in your code or within Vellum."
metaTitle: "Setting Up an OpenAI Model on Microsoft Azure"
publishedAt: "2023-11-20T00:00:00.000Z"
isFeatured: true
expertVerified: false
guestPost: false
isGeo: false
ctaLabel: "Set up an OpenAI model on Azure today."
authors: ["Noa Flaherty  "]
category: "Guides"
tags: ["Deployments"]
featuredImage: "https://cdn.sanity.io/images/ghjnhoi4/production/f159cac45b259fe3626e87425d54c8c0557647f3-1107x762.png"
---

Using OpenAI&nbsp;models hosted on Microsoft Azure has a number of benefits , most notably greater scalability and reliability.

However, the learning curve to get it all set up can be quite steep.

This step-by-step guide shows everything you need to do get up and running.

Note that if you're a Vellum customer, you can use the resulting model in&nbsp;Vellum like you would any other!

‍

Prerequisites

If you haven't already, sign up for a Microsoft Azure account by going here . Then, apply for access to Azure OpenAI&nbsp;service by filling out the form here .

Proceed with the remaining steps once you've been notified that your access has been granted.

‍

Configuring OpenAI on Azure

## Navigate to Azure AI Services

First navigate to the Azure OpenAI page within Azure AI services.

![](https://cdn.sanity.io/images/ghjnhoi4/production/0ea8ab0b18ffe8db7a19e91f306d401ca4c2db58-898x209.png)

## Create a Resource

Once you are on the Azure OpenAI page, click the “Create” button on the top left of the dashboard. This is a Azure resource that could host multiple different OpenAI models.

![](https://cdn.sanity.io/images/ghjnhoi4/production/4371c6c54bcfa0d1faa4e36966b570e92a9aa5a5-459x218.png)

## Choose the Resource’s Name

Fill out the Basics section, specifying the project and region this model will be used in. Choose a custom name that will serve as your resource’s identifier.

![](https://cdn.sanity.io/images/ghjnhoi4/production/5acd74c75954ee901a27390a8c0482965713f2f0-749x507.png)

## Choose Network Type

Select the network that will have access to the model. "All networks" should be sufficient if you don’t have any additional VPNs configured.

![](https://cdn.sanity.io/images/ghjnhoi4/production/2e222fc0fc1a19eb8a344a38d2990125f02d0160-770x308.png)

## Add Any Relevant Tags

Azure tags are helpful for grouping related resources on your Azure account. If you don’t plan to have any tags set up yet, click Next to continue.

Tags can always be added and edited later.

![](https://cdn.sanity.io/images/ghjnhoi4/production/cb794fa99f76020383ca1d4b6163a52c08e26c04-776x275.png)

## Review &amp; Create

Review your endpoint settings to make sure it looks as expected and click “Create” when ready. This will start deploying your endpoint, which will be the container for whichever OpenAI models you’d like to stand up.

![](https://cdn.sanity.io/images/ghjnhoi4/production/fe02ff09456710d7853cc1f6593aaeb8f14ea25f-728x927.png)

## Go to Resource

Once the deployment is complete, click the “Go to resource” button below to start setting up the model itself.

![](https://cdn.sanity.io/images/ghjnhoi4/production/55ffe625e88e0c6498de4ba6a749f2fb15a03b23-398x262.png)

## Go to Azure OpenAI Studio

Once you’re on the resource, click the tab towards the top of the page to take you to Azure OpenAI Studio.

![](https://cdn.sanity.io/images/ghjnhoi4/production/c0a3fda538ac6f13d1150261f61930ef3c481c39-519x118.png)

‍

## Navigate to the Deployments Tab

On the left sidebar, click on the Deployments tab.

![](https://cdn.sanity.io/images/ghjnhoi4/production/6760bed99ca83337d1efa71422175b66cd8a101f-231x552.png)

## Create new Deployment

Click on the "Create new deployment" button towards the top of the dashboard.

![](https://cdn.sanity.io/images/ghjnhoi4/production/45f855ac099140e59bc801541acff0cc9721270a-333x215.png)

## Fill out Deploy model form

Fill out the Deploy model form by selecting a model and assigning it a Deployment name. Save the model and deployment name entered as you will need to refer to it in your code or when adding the model to Vellum.

Click Create when ready.

![](https://cdn.sanity.io/images/ghjnhoi4/production/ce6f01f676e581f5125f115b73cf4e80b08be864-640x521.png)

## Navigate to Endpoints

Head back to your main deployment page and click on the link to view endpoints.

![](https://cdn.sanity.io/images/ghjnhoi4/production/679ea0f79b3346870f47217f46831faf233c52fe-1339x196.png)

## Copy Endpoint URL and API Key

Copy the endpoint URL and Key 1 and enter both of those values below. You again need both to reference in your code, or when adding the model to Vellum .

![](https://cdn.sanity.io/images/ghjnhoi4/production/0e3f578ccb72c4611b61a1d415c926b82dec266a-782x505.png)

## Integrating w/ Your Newly Deployed Model

You now have a ready-to-go OpenAI&nbsp;model hosted on Microsoft Azure. For more info on how to integrate with Microsoft's API directly, see here . If you're a Vellum customer, you'll probably want to use your newly deployed model through Vellum . This way, you can benchmark it against existing models, run evaluations against it, and use it from within&nbsp;Workflows or Prompt Deployments.

To take advantage of these benefits, you'll need to add this model to Vellum via the models page . On this page you'll find an option to securely enter your model details.

And here's a demo video of how to use Azure-hosted OpenAI models directly from within Vellum.

![](https://cdn.sanity.io/images/ghjnhoi4/production/891ae8ca4e2bb5ecf6e4b01d249cadfc8d06b549-2130x942.png)

Once added, you'll see this model throughout Vellum and can use it like you would any other!

## Table of Contents

Prerequisites Instructions for configuring OpenAI on Azure
