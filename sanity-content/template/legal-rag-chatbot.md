---
title: "Legal RAG chatbot"
slug: "legal-rag-chatbot"
shortDescription: "Chatbot that provides answers based on user queries and legal documents."
heroIntroParagraph: "Chat with my legal documents"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/1e68ab93-8d8a-436c-95de-61b48a65be7b?releaseTag=LATEST"
workflowId: "1e68ab93-8d8a-436c-95de-61b48a65be7b?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-10-14T00:00:00.000Z"
featured: false
workflowTag: "RAG"
industry: "Legal"
categoryTags: ["Chatbot / Assistant", "RAG", "Data extraction"]
createdByTeam: "Nicolas Zeeb"
---

## Content

This workflow creates a legal RAG chatbot that generates comprehensive legal answers based on user queries and relevant legal documents. It allows users to search legal documents, format the results, and provide answers with proper citations in both markdown and JSON formats.

‍

## How it Works / How to Build It

Legal Search : This node performs a search on the specified legal documents using the user’s query. It retrieves relevant documents based on semantic and keyword matching. Format Search Results : This node formats the search results, including citation metadata, to prepare them for analysis. Legal Answer Generator : This node generates a legal answer based on the formatted search results and the user’s query. It outputs the answer and citations in JSON format. Format Answer Markdown : This node takes the JSON output from the Legal Answer Generator and formats it into a markdown response, including the answer and citations. Final Output Answer : This node outputs the formatted answer in markdown. Format Citations Json : This node extracts and formats the citations from the JSON output into a clean JSON format. Final Output Citations : This node outputs the formatted citations in JSON.

## What You Can Use This For

Legal teams can quickly get answers to legal questions based on internal documents. Law firms can automate responses to common legal inquiries. Compliance departments can ensure that responses are backed by proper documentation and citations.

## Prerequisites

Vellum account Access to a set of legal documents (e.g., PDFs or text files) Basic understanding of how to use the Vellum workflow builder

## How to Set It Up

Clone the "Template_Legal RAG Assistant" workflow from the Vellum library. Configure the LegalSearch node to point to your legal document index. Set up the Inputs to include your document set, chat history, and user query. Connect the nodes in the specified order: LegalSearch → FormatSearchResults → LegalAnswerGenerator → {Format Answer Markdown, Format Citations Json}. Test the workflow by inputting a sample query and reviewing the outputs from Final Output Answer and Final Output Citations .

## FAQ

#### 1. Can I adapt this workflow for my own legal documents or internal knowledge base?

Yes, the Legal Search node is fully configurable. You can connect it to any document index, whether that’s internal memos, contracts, or case law databases. Once connected, the workflow will automatically ground answers in your organization’s content instead of public data.

#### 2. How does this workflow make sure answers are grounded and properly cited?

Every response is based on the retrieved legal documents. The Legal Answer Generator references those documents directly, while the Format Citations Json node extracts verifiable citations. This ensures transparency you need to always trace a claim back to the source.

#### 3. Can I change how the answer is formatted or what metadata it includes?

Definitely, the Format Answer Markdown and Format Citations Json nodes are designed for easy editing. You can add sections like “Summary,” “Relevant Statutes,” or “Jurisdiction Notes,” or export results in other formats such as plain text or HTML.

#### 4. What types of legal content does this work best with?

This agent performs best with well-structured legal documents — such as contracts, case law, regulatory filings, or policy handbooks. It can handle both text and PDF inputs, as long as the documents are properly indexed or parsed before retrieval.

#### 5. How can I extend this workflow beyond legal use cases?

The RAG pattern here is universal. You can reuse the same structure for policy research, compliance Q&amp;A, or academic summarization by swapping the document index and updating prompts. It’s an easy way to turn any text repository into a reliable, cited knowledge agent.
