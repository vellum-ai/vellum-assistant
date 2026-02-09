---
title: "Healthcare explanations of a patient-doctor match"
slug: "personalized-healthcare-description-based-on-patient-doctor-match"
shortDescription: "Summarize why a patient was matched with a specific provider."
heroIntroParagraph: "Generate patient-doctor match rationale"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/0a9f3a2b-8b5a-46ed-8aa7-cce88d757d49?releaseTag=LATEST"
workflowId: "0a9f3a2b-8b5a-46ed-8aa7-cce88d757d49"
createdBy: "f1d197f770500bdd62e7051bf66fbb2a"
date: "2025-08-14T00:00:00.000Z"
featured: false
workflowTag: "Content generation"
industry: "Healthcare"
categoryTags: ["Data extraction"]
createdByTeam: "Lawrence Perera  "
---

## Content

This workflow generates a personalized explanation of why a specific healthcare provider is a good match for a patient based on their needs and preferences. It processes patient and provider information to identify matches and create a clear, factual explanation.

## How it Works / How to Build It

PII Redaction : This node takes the patient information and redacts any personally identifiable information (PII) to ensure privacy. It outputs a sanitized JSON object containing relevant patient details. Find Match Evidence : This node analyzes the sanitized patient information and provider information to identify matches. It uses a prompt to categorize the match strength as either 'strong' or 'partial' and returns a JSON array of matched pairs. Extract Provider Name : This node extracts the provider's name from the provider information, which will be used in the final explanation. Gen Match Explanation : This node generates a neutral, fact-based explanation of why the provider is a good match for the patient, using the evidence gathered in the previous steps. Output : This node formats the final explanation into a structured output for the user.

## What You Can Use This For

Healthcare teams can use this workflow to provide personalized match explanations for patients seeking providers. Patient support services can leverage this to enhance communication and transparency regarding provider recommendations. Insurance companies can utilize it to explain provider options to clients based on their specific needs.

## Prerequisites

Vellum account JSON schema for patient information and provider information

## How to Set It Up

Create a new workflow in your Vellum account. Add the PII Redaction node and connect it to the input for patient information. Add the Find Match Evidence node and connect it to the output of the PII Redaction node and the provider information input. Add the Extract Provider Name node to extract the provider's name from the provider information. Connect the Gen Match Explanation node to the outputs of both the Find Match Evidence and Extract Provider Name nodes. Finally, connect the Output node to the Gen Match Explanation node to finalize the workflow.
