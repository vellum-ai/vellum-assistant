---
fixture: desktop-app
---

# Tool Permission Prompts

## Goal

Verify that when the assistant attempts to run a tool that requires user permission (e.g. host_bash), a permission prompt is displayed to the user before execution.

## Steps

1. Launch the App
2. Open a chat thread
3. Send a message that triggers a tool requiring permission, such as "run `ls` in my home directory"
4. Wait for the assistant to respond
5. Verify that a tool permission prompt appears asking the user to allow or deny the action

## Expected

- A permission prompt should appear before the tool is executed
- The prompt should clearly identify the tool and action being requested
- The tool should NOT execute until the user responds to the prompt
