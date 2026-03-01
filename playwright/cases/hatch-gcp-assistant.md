---
fixture: desktop-app
experimental: true
required_env: ANTHROPIC_API_KEY
---

# Hatch Assistant on GCP

## Goal

Verify that the full onboarding flow completes successfully: launch the app, enter an API key, and hatch an assistant on GCP.

## Steps

1. Launch the App
2. Click the "Own API Key" Start button
3. Verify that the API key input is rendered
4. Enter your Anthropic API key into the input field using type_env_var with ANTHROPIC_API_KEY
5. Verify that the Hatch button is enabled
6. Select GCP as the cloud provider
7. Click the Hatch button
8. Wait for the hatching process to begin and observe progress indicators
9. Wait for the hatching process to complete (this may take several minutes)
10. Verify that the assistant has been successfully hatched and the app transitions to the main chat interface

## Expected

- The app should accept the API key and enable the Hatch button
- Selecting GCP as the cloud provider should work without errors
- The hatching process should start and show progress feedback to the user
- After hatching completes, the app should transition to the main chat interface with a ready-to-use assistant
