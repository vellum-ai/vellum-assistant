---
title: "Agent that summarizes lengthy reports (PDF -> Summary)"
slug: "pdf-document-summarization"
shortDescription: "Summarize all kinds of PDFs into easily digestible summaries. "
heroIntroParagraph: "Summarize my PDFs into digestible summaries"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/pdf-document-summarization?releaseTag=LATEST"
workflowId: "pdf-document-summarization"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "Document extraction"
industry: "Insurance"
categoryTags: ["Document extraction", "AI Agents"]
createdByTeam: "Anita Kirkovska"
---

## Content

This agent summarizes a PDF document by processing its contents through the Vellum Document API and generating a user-friendly summary. It allows users to input a document ID and receive a concise summary of the document's text.

‍

### How it Works / How to Build It

DocumentAPIURL : This node constructs the API URL using the provided document_id from the user inputs. DocumentAPI : This node calls the Vellum API to retrieve the document's contents using the constructed URL and an API key for authorization. ProcessedDocumentURL : This node extracts the URL of the processed document from the API response. ProcessedDocumentContents : This node fetches the actual contents of the processed document using the URL obtained in the previous step. PromptNode : This node generates a summary of the document's contents by prompting a machine learning model with the text retrieved. FinalOutput : This node outputs the generated summary for user display.

### What You Can Use This For

Summarizing lengthy reports for quick insights. Creating concise overviews of legal documents for review. Generating summaries of research papers for academic purposes. Providing quick summaries of internal documentation for team members.

### Prerequisites

Vellum account. Access to the Vellum API with a valid API key. PDF documents uploaded to the Vellum system.

### How to Set It Up

Create a new workflow in your Vellum account. Add the DocumentAPIURL node and configure it to accept the document_id input. Connect the DocumentAPI node to the DocumentAPIURL node. Link the ProcessedDocumentURL node to the DocumentAPI node. Connect the ProcessedDocumentContents node to the ProcessedDocumentURL node. Add the PromptNode and link it to the ProcessedDocumentContents node. Finally, connect the FinalOutput node to the PromptNode to display the summary.
