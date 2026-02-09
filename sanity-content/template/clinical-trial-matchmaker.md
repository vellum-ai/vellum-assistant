---
title: "Clinical trial matchmaker"
slug: "clinical-trial-matchmaker"
shortDescription: "Match patients to relevant clinical trials based on EHR."
heroIntroParagraph: "Find relevant clinical trials for my patients"
onboardingUrl: "https://app.vellum.ai/onboarding/open-in-vellum/a49262fe-161c-4044-b352-bd1341952d14?releaseTag=LATEST"
workflowId: "a49262fe-161c-4044-b352-bd1341952d14?releaseTag=LATEST"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-10-14T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Healthcare"
categoryTags: ["Document extraction", "Data extraction", "AI Agents"]
createdByTeam: "Nicolas Zeeb"
---

## Content

### How it works

Ehr Normalization : This node extracts and normalizes key patient information from the EHR profile, including demographics, diagnosis, medications, and exclusion factors. Search Trials : Using the normalized patient data, this node searches a document index for relevant clinical trials. Trial Scoring : This node scores each trial based on how well the patient matches the eligibility criteria, providing detailed explanations for the scores. Rank Trials : It ranks the trials based on the scores from the previous node and formats the output for clarity. Outreach Message Draft : This node drafts personalized outreach messages for both physicians and patients, summarizing the patient profile and the top matched trials. Final Output Outreach Message : Outputs the finalized outreach message for physicians and patients. Final Output Ranked Trials : Outputs the ranked list of clinical trials along with their match scores and explanations.

### How can you use this agent

Patient recruitment for clinical trials in healthcare settings. Generating personalized communication for physicians regarding trial options. Enhancing patient engagement by providing tailored information about clinical trials.

### Prerequisites

Vellum account. Access to a document index containing clinical trial information. Patient EHR profiles and consent status data.

### How to build this agent

Duplicate the template from above Prompt the agent builder in Vellum

## FAQ

1. Can I connect this workflow to my organization’s EHR system?

Yes, the Ehr Normalization node can be configured to pull data from your internal EHR or FHIR API. It accepts structured or semi-structured patient data — such as demographics, diagnosis codes, and medication lists — and normalizes them for accurate matching. You can also add a preprocessing step to anonymize patient identifiers before execution.

2. How does the agent decide which clinical trials best fit a patient?

The Trial Scoring node evaluates each trial’s eligibility criteria against the patient’s normalized profile, generating both a numerical match score and a text-based rationale. The RankTrials node then orders the trials based on these scores, ensuring the top matches are the most clinically appropriate.

3. How do I ensure patient data remains private and compliant?

This workflow is designed to operate in HIPAA-compliant environments. You can configure it to de-identify all patient information prior to processing, and securely manage access to the EHR and trial index using encrypted credentials. No PHI should leave your organization’s infrastructure unless explicitly authorized.

4. Can I customize the outreach messages for different audiences?

Yes, the Outreach Message Draft node can be modified to produce messages tailored to physicians, patients, or research coordinators. For instance, you might create a more clinical tone for physicians and a simplified, empathetic tone for patient-facing communication.

5. How can I extend this workflow beyond trial matching?

The same architecture can support other patient-trial operations like eligibility analytics , trial feasibility studies , or site recruitment optimization . By adjusting the data inputs and scoring logic, this becomes a broader research-matching or population health insights engine.
