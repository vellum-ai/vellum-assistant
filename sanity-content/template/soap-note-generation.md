---
title: "SOAP Note Generation Agent"
slug: "soap-note-generation"
shortDescription: "Extract subjective and objective info, assess and output a treatment plan."
heroIntroParagraph: "Generate a SOAP note from a medical transcript"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/2d0c9f3a-f9d2-418c-a4ff-eae4416b7471?releaseTag=VEL_PUBLIC&condensedNodeView=1&showOpenInVellum=1"
workflowId: "2d0c9f3a-f9d2-418c-a4ff-eae4416b7471?releaseTag=VEL_PUBLIC&condensedNodeView=1&showOpenInVellum=1"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "Document extraction"
industry: "Healthcare"
categoryTags: ["Data extraction", "Document extraction"]
createdByTeam: "Anita Kirkovska"
---

## Content

This agentic workflow generates a structured SOAP note from a medical transcript by extracting subjective and objective information, assessing the data, and formulating a treatment plan.

‍

### How it Works / How to Build It

Subjective Node : Extracts patient-reported symptoms and health history from the transcript using the Subjective node. Objective Node : Extracts the doctor’s observations, including vitals and physical exam results, using the Objective node. Merge Node : Combines the outputs of the Subjective and Objective nodes using the MergeNode . Assessment Node : Generates a clinical assessment based on the combined subjective and objective data using the Assessment node. Plan Node : Creates a treatment plan based on the assessment using the Plan node. Final Merge Node : Merges the outputs of the Assessment and Plan nodes using MergeNode9 . Final SOAP Note Generation : Compiles all sections (Subjective, Objective, Assessment, Plan) into a final SOAP note format using the FinalSOAPNoteGeneration node. SOAP Note JSON Output : Outputs the final SOAP note in JSON format using the SOAPNoteJSON node.

### What You Can Use This For

Generating SOAP notes for patient visits in healthcare settings. Streamlining documentation for medical professionals. Automating the creation of clinical records from audio or text transcripts.

### Prerequisites

Vellum account. Access to medical transcripts in text format.

### How to Set It Up

Create a new workflow in Vellum and import the necessary nodes. Set up the Inputs class to accept a transcript string. Configure the Subjective and Objective nodes to extract relevant information from the transcript. Connect the Subjective and Objective nodes to the MergeNode . Link the MergeNode output to the Assessment node.
