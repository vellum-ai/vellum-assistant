---
title: "PDF Data Extraction to CSV"
slug: "extract-data-from-pdf-to-csv"
shortDescription: "Extract unstructured data (PDF) into a structured format (CSV)."
heroIntroParagraph: "Extract data from PDF into a CSV file"
onboardingUrl: "http://app.vellum.ai/onboarding/open-in-vellum/8db5c0a5-2644-4ac8-9f9f-314ac8abb950?releaseTag=LATEST"
workflowId: "8db5c0a5-2644-4ac8-9f9f-314ac8abb950"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "Document extraction"
industry: "Legal"
categoryTags: ["Data extraction"]
createdByTeam: "Anita Kirkovska"
---

## Content

This agentic workflow extracts data from PDF files and converts it into structured CSV format. It processes each page of the PDF, generating separate CSV outputs for menu items, invoices, and product specifications.

‍

### How it Works / How to Build It

GetParseEachPage : This node takes a list of PDF file names as input and initiates the subworkflow to process each page of the PDFs. GetPage : This templating node retrieves each page of the PDF based on the input item. GetPage1 : This search node queries the document index for the specific page content, applying weights for semantic similarity and keywords. ParseProcessedPDF : This inline prompt node processes the unstructured text data retrieved from the PDF and converts it into a structured CSV format. ProcessedPDF : This final output node captures the processed CSV output from the ParseProcessedPDF node. MenuCSVOutput, InvoiceCSVOutput, ProductSpecCSVOutput : These nodes output the structured data into separate CSV files for menu items, invoices, and product specifications.

### What You Can Use This For

Automating the extraction of data from invoices for accounting teams. Generating product specifications from product catalogs for marketing teams. Creating menu item lists from restaurant PDFs for operations teams.

### Prerequisites

Vellum account. PDF files containing the data to be extracted.

### How to Set It Up

Clone the workflow template in your Vellum account. Upload your PDF files to the designated input field in the Inputs node. Connect the GetParseEachPage node to the MenuCSVOutput , InvoiceCSVOutput , and ProductSpecCSVOutput nodes. Configure any additional settings as needed for your specific use case. Run the workflow to generate the CSV outputs.
