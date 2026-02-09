---
title: "Extract data from M&A contract"
slug: "extract-key-points-from-m-a-contract"
seoTitle: "AI document extraction for M&A Contract"
description: "Build a Workflow that splits a legal contract, extracts key info in parallel, and gives you a summary with sources cited."
shortDescription: "Extract specific information from a legal contract."
publicWorkflowTag: "49951eec-149b-4e75-9480-538ec6c7587d"
industry: "Legal"
coverImage: "https://cdn.sanity.io/images/ghjnhoi4/production/7e8a0025f5d5f140140ba1a81b1a8a8d37739614-1344x896.png"
---

## Workflow Nodes

### Step 3: AI document data extraction

Use prompt nodes to extract risk, compliance, and liability analysis from documents and merge it into a final answer.

### Step output: Final doc analysis (Output)

### Risks Analysis &nbsp;

Based on the extracted clauses and information from the DEFM14A, there are several potential risks in the indemnification and liability terms that could expose the company to future legal issues: &nbsp; 1. Lack of Limitation of Liability Clause: The absence of a limitation of liability clause is a significant risk. Without such a clause, the company may be exposed to unlimited liability for claims arising from the contractor's actions or omissions. This could lead to substantial financial exposure in the event of a lawsuit or claim, particularly if the damages are significant. &nbsp; 2. Broad Indemnification Obligations: The indemnification provisions require the contractor to defend and indemnify the company for a wide range of issues, including acts of subcontractors and failure to comply with laws and regulations. While this may seem beneficial, it could lead to disputes over the scope of indemnification. If the contractor fails to fulfill these obligations, the company may face unexpected liabilities. &nbsp; 3. Indemnification for Subcontractor Actions: The clause stating that the contractor will indemnify the company for the acts of subcontractors could create complications. If a subcontractor engages in negligent or unlawful behavior, the company may find itself entangled in legal disputes, and the contractor may not have the financial resources to cover the indemnification, leaving the company exposed. &nbsp; 4. Reimbursement for Fines and Penalties: The requirement for the contractor to reimburse the company for fines, penalties, and expenses due to non-compliance with laws and regulations could lead to disputes over what constitutes non-compliance. If the contractor contests the fines or penalties, the company may have to engage in lengthy and costly legal battles to recover these amounts. &nbsp; 5. Ambiguity in Indemnification Scope: The indemnification clauses contain broad language, such as "any and all expenses, costs, loss, liabilities and obligations." This could lead to ambiguity regarding what is covered and may result in disputes over the interpretation of these terms. The company may find itself in a position where it has to defend its interpretation in court. &nbsp; 6. Confidentiality Concerns: While there is a mention of confidentiality agreements for auditors, the overall lack of explicit confidentiality obligations in the agreement raises concerns. If sensitive information is disclosed or mishandled, the company may face reputational damage or legal repercussions without clear recourse. &nbsp; 7. Termination Procedures: The absence of explicit termination procedures could lead to confusion and disputes if either party seeks to terminate the agreement. This lack of clarity may result in prolonged negotiations or litigation over the terms of termination, which could be costly and time-consuming. &nbsp;

In summary, the company should consider revising the indemnification and liability terms to include a limitation of liability clause, clarify the scope of indemnification, and establish clear termination procedures. Additionally, enhancing confidentiality obligations would mitigate risks associated with sensitive information. Legal counsel should be engaged to ensure that these provisions adequately protect the company's interests. &nbsp;

### Compliance Analysis &nbsp;

The confidentiality clause in the provided contract data does not fully comply with standard GDPR regulations. Here are the key points regarding GDPR compliance and the necessary modifications: &nbsp;

Key GDPR Requirements for Confidentiality Clauses: &nbsp; 1. Explicit Definition of Personal Data: The clause should clearly define what constitutes personal data under GDPR. &nbsp; 2. Purpose Limitation: The confidentiality obligations should specify the purposes for which personal data can be processed. &nbsp; 3. Data Subject Rights: The clause should acknowledge the rights of data subjects (e.g., right to access, rectification, erasure). &nbsp; 4. Data Breach Notification: There should be a requirement for the contractor to notify the company in the event of a data breach. &nbsp; 5. Subcontractor Obligations: If subcontractors are involved, the clause should ensure that they also adhere to the same confidentiality obligations. &nbsp; 6. Duration of Confidentiality: The duration for which confidentiality must be maintained should be specified. &nbsp;

Modifications Needed: &nbsp; 1. Add a Clear Confidentiality Clause: Include a specific confidentiality clause that outlines the obligations of both parties regarding personal data. &nbsp; 2. Define Personal Data: Clearly define what constitutes personal data in the context of the agreement. &nbsp; 3. Specify Purposes for Data Processing: State the specific purposes for which personal data may be processed. &nbsp; 4. Include Data Subject Rights: Acknowledge and outline the rights of data subjects in relation to their personal data. &nbsp; 5. Data Breach Notification Requirement: Include a provision requiring the contractor to notify the company of any data breaches within a specified timeframe. &nbsp; 6. Subcontractor Compliance: Ensure that any subcontractors are also bound by the same confidentiality obligations. &nbsp; 7. Duration of Confidentiality: Specify how long the confidentiality obligations will last after the termination of the agreement. &nbsp;

By incorporating these modifications, the confidentiality clause will be more aligned with GDPR requirements, ensuring better protection of personal data and compliance with legal standards. &nbsp;

Liability Analysis &nbsp; In reviewing the limitation of liability clause from the provided DEFM14A data, it is notable that the document does not explicitly mention a limitation of liability clause at all. This is a significant deviation from typical industry standards, where a limitation of liability clause is commonly included to define the extent of liability for both parties in the event of a breach or other claims arising from the contract. &nbsp;

Major Deviations: &nbsp; 1. Absence of Limitation of Liability Clause: &nbsp; &nbsp; - Current Contract: The document explicitly states that it does not include a limitation of liability clause. &nbsp; &nbsp; - Typical Industry Practice: Most contracts include a limitation of liability clause that typically caps the liability of each party to a certain amount (often related to the fees paid under the contract) or excludes certain types of damages (like consequential or punitive damages). This clause serves to protect both parties from excessive liability and provides a clear framework for potential claims. &nbsp; 2. Potential Risks: &nbsp; &nbsp; - Without a limitation of liability clause, the parties may face unlimited exposure to damages, which can lead to significant financial risk. This could deter parties from entering into the agreement or lead to disputes over liability in the event of a breach or other issues. &nbsp; 3. Indemnification Provisions: &nbsp; &nbsp; - While the contract includes indemnification provisions, which are important for protecting against specific liabilities, these do not replace the need for a limitation of liability clause. Indemnification typically covers specific scenarios (like third-party claims) but does not limit the overall liability of the parties involved. &nbsp;

Conclusion: &nbsp; The absence of a limitation of liability clause in this contract is a major deviation from standard industry practices. It is advisable for the parties involved to consider including such a clause to mitigate risks and clarify the extent of liability in the event of disputes.‍

### Step document: Ingest Contract for processing (Input)

DEF 14A (Definitive Proxy Statement)

### Step 2: Parallel document processing

Foreach page chunk use a predefined JSON Schema (using structure outputs) to parse all elements in parallel using the Map Node in Vellum.

### Step 1: Split Document into Partitions

The function cuts the document to 1/5th for testing, calculates the size of each chunk, and splits the document into equal parts. The last chunk includes any leftover content

## Tools

- Data Extraction
- Parallel processor
- Router
- Parser

## AI Tasks

- **Data extraction**

## Customizations

1/ Adjust chunk sizes and context in each processed chunk

2/ Parse PDFs, Google Docs, Notion Docs, URLs, Plain Text

3/ Use out of box RAG to ask questions against the doc

4/ Add custom evaluation metrics

5/ Try different models and compare performance
