---
fixture: desktop-app
status: experimental
---

# Tool Permission Prompts

## Goal

Verify that when the assistant attempts to run a tool that requires user permission (e.g. host_bash), a permission prompt is displayed to the user before execution.

## Steps

1. Launch the App
2. Open a chat thread
3. Send a message that triggers a tool requiring permission, such as "create a file called test.txt on my Desktop"
4. Wait for a permission prompt to appear **inline in the chat** — it will show buttons like "Allow Once", "Always Allow", and "Don't Allow" directly within the conversation. Do NOT click any of these buttons.
5. Verify that the inline permission prompt is visible with action buttons before the tool has executed

## Expected

- A permission prompt should appear **inline in the chat** before the tool is executed, with buttons such as "Allow Once", "Always Allow", and "Don't Allow"
- The prompt should clearly identify the tool and action being requested
- The tool should NOT execute until the user responds to the prompt — do NOT click any approval buttons during this test
