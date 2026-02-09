---
title: "Synthetic Dataset Generator"
slug: "synthetic-dataset-generation-workflow"
shortDescription: "Generate a synthetic dataset for testing your AI engineered logic."
heroIntroParagraph: "Generate a synthetic dataset for AI evals"
onboardingUrl: "http://app.vellum.ai/onboarding/open-in-vellum/9699b03f-3eee-4660-bfdb-11441f15ae8f?releaseTag=LATEST"
workflowId: "9699b03f-3eee-4660-bfdb-11441f15ae8f"
createdBy: "1e36e038c75cc5fab5aef201f342b644"
date: "2025-07-31T00:00:00.000Z"
featured: false
workflowTag: "AI Agents"
industry: "Marketing"
categoryTags: ["Evaluation", "AI Agents"]
createdByTeam: "Nico Finelli"
---

## Content

This agent generates a synthetic dataset for testing an AI pipeline by creating test cases based on user-defined parameters. It allows users to specify the purpose of the AI pipeline, the number of test cases to generate, and any additional context, then outputs the test cases formatted as an API request body.

‍

### How it works

URL Node : Initializes the workflow with a predefined URL for the evaluation report. APINode : Sends a request to the specified API endpoint to retrieve example data. Example Node : Processes the API response to extract relevant example data for generating test cases. PromptNode : Constructs a prompt for the AI model, incorporating user inputs and examples to generate test cases. TestCases Node : Formats the output from the PromptNode into a JSON structure suitable for API requests. CURLBody Node : Executes a script to update the IDs of the generated test cases to ensure they are unique and deterministic. BulkURL Node : Creates a URL for bulk API requests based on the test suite name. PastedFromCURL Node : Sends the formatted test cases to the API endpoint using a POST request. FinalOutput Node : Outputs the final result of the workflow, which includes the generated test cases.

### How can you use it

Generating test cases for AI model validation in software development. Creating synthetic datasets for machine learning experiments. Automating the testing process for AI pipelines in data science teams. Providing a structured format for API requests in testing environments.

#### Prerequisites

Vellum account. API key for authentication with Vellum Test Suites Number of test cases to generate. Optional additional context for test case generation.

### How to Set It Up

Clone the workflow template in your Vellum account. Input the workflow_purpose , test_suite_name , and number_of_test_cases in the Inputs section. (Optional) Add any additional_context that may help in generating test cases. Ensure your API key is correctly set in the APINode for authentication. Run the workflow to generate the test cases and retrieve the final output.
