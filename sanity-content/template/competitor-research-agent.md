---
title: "Competitor research agent"
slug: "competitor-research-agent"
shortDescription: "Scrape relevant case studies from competitors and extract ICP details."
heroIntroParagraph: "Find ICP signals in competitor case studies"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/b76793b9-71ae-4f98-bbb8-c3637f32f08e?releaseTag=LATEST"
workflowId: "b76793b9-71ae-4f98-bbb8-c3637f32f08e?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-09-26T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Marketing"
categoryTags: ["AI Agents", "Data extraction"]
createdByTeam: "Anita Kirkovska"
---

## Content

This workflow extracts case study information from a specified URL and organizes it into a Notion page. It automates the process of finding relevant case studies, scraping their content, and formatting the data for easy access and readability.

‍

## How it Works / How to Build It

UrlMapper : This node takes a URL as input and maps the website to discover all relevant case study links. It returns a list of URLs that appear to be case studies or customer testimonials. CaseStudyUrlsExtractor : This node processes the output from the UrlMapper to filter and extract unique case study URLs from the list. MapCaseStudies : This node iterates over each case study URL and triggers a sub-workflow to scrape the content and extract structured user information. NotionAgent : This node takes the extracted case study data and formats it for a Notion page. It searches for a specific page in Notion and creates a new page to store the case study information. FinalOutput : This node outputs the formatted case study data to the user, ensuring that all information is presented clearly.

## What You Can Use This For

Marketing teams can gather and organize customer testimonials for case studies. Product teams can analyze user feedback and success stories from case studies. Content teams can create structured documentation of customer experiences for internal use.

## Prerequisites

Vellum account Access to a Notion workspace A URL containing case studies or customer testimonials

## How to Set It Up

Clone the workflow template into your Vellum account. Input the URL of the website you want to scrape for case studies. Ensure you have the necessary permissions to access and modify the Notion workspace. Run the workflow to extract case study information and create a new Notion page with the results. Review the output in Notion to ensure the formatting meets your needs.

‍
