---
fixture: desktop-app
status: experimental
---

# Hatch Assistant on GCP

## Goal

Verify that the full onboarding flow completes successfully: launch the app, enter an API key, and hatch an assistant on GCP.

## Steps

1. Launch the App
2. Click the "Own API Key" Start button
3. Select GCP as the hosting mode
4. Verify that the API key input is rendered
5. Enter your Anthropic API key into the input field
6. Click the "Continue" button
7. Verify that the GCP credentials form is rendered with Project ID, Zone, and Service Account Key fields
8. Enter the GCP Project ID
9. Select a GCP Zone from the dropdown
10. Upload the GCP Service Account Key JSON file
11. Click the "Hatch!" button
12. Wait for the hatching process to begin and observe progress indicators
13. Wait for the hatching process to complete (this should take less than 2 minutes)
14. Verify that the assistant has been successfully hatched and the app transitions past the hatching screen

## Expected

- The app should accept the API key and show the Continue button
- Selecting GCP as the hosting mode should work without errors
- The GCP credentials form should accept a Project ID, Zone, and Service Account Key
- The hatching process should start and show progress feedback to the user
- After hatching completes, the app should transition past the hatching screen with a successfully hatched assistant
