---
title: "Prior authorization navigator"
slug: "prior-authorization-navigator"
shortDescription: "Automate the prior authorization process for medical claims."
heroIntroParagraph: "Speed up prior authorizations for claims"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum//a49262fe-161c-4044-b352-bd1341952d14?releaseTag=LATEST&condensedNodeView=1&showOpenInVellum=1"
workflowId: "a49262fe-161c-4044-b352-bd1341952d14?releaseTag=LATEST&showOpenInVellum=1"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-10-14T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Healthcare"
categoryTags: ["AI Agents"]
createdByTeam: "Nicolas Zeeb"
---

## Content

This workflow automates the prior authorization process for medical claims by extracting relevant medical codes from provider notes, evaluating the need for human review, and generating necessary documentation based on payer policies.

## How it Works / How to Build It

Extract Medical Codes Node : This node takes the provider note as input and extracts relevant medical information, including diagnoses, CPT codes, ICD-10 codes, procedures, and clinical justification. Extract Codes Json : Converts the extracted medical codes into a JSON format for easier handling and output. Format Search Query Node : Formats the extracted codes into a search query to find relevant payer policies. Search Payer Policies Node : Searches a database of healthcare documents using the formatted query to retrieve relevant payer policy rules. Evaluate Confidence Node : Uses a machine learning model to assess whether the case can be auto-approved or requires human review based on the extracted codes and payer policies. Conditional Router Node : Routes the workflow based on the confidence evaluation. If auto-approval is possible, it proceeds to generate an authorization form; if human review is needed, it flags the case for review. Generate Auth Form Node : Generates a comprehensive prior authorization form based on the insurance plan details, provider note, extracted medical information, and confidence assessment. Final Output Form Node : Outputs the generated prior authorization form. FinalOutput : Outputs the extracted medical codes. FinalOutput1 : Outputs the confidence evaluation. FinalOutputReviewNode : Outputs the human review package if needed.

## What You Can Use This For

Automating prior authorization requests in healthcare settings. Streamlining the extraction of medical codes from provider notes. Evaluating the need for human intervention in the authorization process. Generating professional prior authorization forms for submission to insurance companies. Flagging cases that require additional review and documentation

## Prerequisites

Vellum account. Access to a database of healthcare documents for payer policies. Provider notes containing patient information and medical details.

## How to Set It Up

Clone the workflow template in your Vellum account. Configure the Inputs node with the necessary provider note and insurance plan details. Ensure the Extract Medical Codes Node is connected to the Extract Codes Json node. Connect the Extract Codes Json to the Format Search Query Node . Link the Format Search Query Node to the Search Payer Policies Node . Connect the Search Payer Policies Node to the Evaluate Confidence Node . Set up the ConditionalRouterNode to route to either the GenerateAuthFormNode or the Flag For Review Node based on the evaluation. Connect the Generate Auth Form Node to the Final Output Form Node . Ensure the Evaluate Confidence Node outputs are connected to the Final Output 1 and Final Output Review Node as needed. Test the workflow with sample data to ensure all nodes are functioning correctly.

## FAQ

### 1. Can I adapt this workflow for different payers or healthcare networks?

Yes, the Search Payer Policies Node can connect to any payer policy database or API, so you can customize it to reflect your organization’s specific payer mix. You can also add routing logic for payers with unique documentation or approval rules.

### 2. How does the agent decide when a case requires human review?

The Evaluate Confidence Node uses an AI model to assess the completeness and clarity of the extracted information. If the confidence score falls below a set threshold or if required codes are missing, the ConditionalRouterNode automatically flags the case for manual review. You can adjust that threshold to match your internal quality or risk tolerance.

### 3. What data does this workflow process, and how do I keep it compliant?

This workflow processes provider notes, CPT and ICD-10 codes, and payer policy documents. All patient data should be de-identified or handled within HIPAA-compliant environments. Vellum supports secure, controlled deployments, so sensitive workflows can be run safely within your organization’s infrastructure.

### 4. Can I scale this to handle multiple prior authorization requests at once?

Yes, you can run this workflow in batch mode or integrate it directly into your claims management system to process multiple provider notes in parallel. Each execution will independently extract, evaluate, and generate the necessary documentation for submission.

### 5. How could I extend this agent beyond prior authorization processing?

You can reuse the same pattern for other healthcare automation tasks, such as claims adjudication , pre-certification reviews , or medical necessity checks . By changing the extraction logic and policy data sources, the workflow can handle a range of document-heavy administrative processes.
