---
fixture: desktop-app
status: critical
---

# Tool Permission Prompts and Denial Handling

## Goal

Verify that the assistant displays a permission prompt before executing a gated tool, and handles both approval and denial gracefully.

## Steps

1. Launch the app
2. Open a chat thread
3. Send a message that triggers a permission-gated tool (e.g. "Create a file called test.txt on my Desktop")
4. Verify that a permission prompt appears **inline in the chat** with buttons: "Allow Once", "Always Allow", and "Don't Allow" — before the tool executes
5. Verify the tool has NOT executed yet at this point
6. Click "Don't Allow"
7. Verify the assistant acknowledges the denial gracefully without crashing or hanging
8. Send a follow-up message (e.g. "hello") to confirm the chat is still responsive
9. Start a new chat thread and repeat steps 3–4
10. This time click "Allow Once"
11. Verify the tool executes successfully and the assistant incorporates the result into its response

## Expected

- The permission prompt appears inline before any tool execution
- The prompt clearly identifies the tool and the action being requested
- Clicking "Don't Allow" results in graceful acknowledgment, no crash, no hang
- The chat remains fully functional after denial
- Clicking "Allow Once" allows the tool to execute successfully
- The assistant responds coherently after tool execution
