---
fixture: desktop-app
status: critical
---

# Tool Call Execution

## Goal

Verify that the assistant can execute tool calls correctly and return results to the user.

## Steps

1. Launch the app
2. Ensure an assistant is hatched and active
3. Send a message that triggers a permission-gated tool call (e.g. "List my files in ~/Downloads")
4. Verify that the assistant outputs a context message before the tool call (explaining what it needs to do)
5. Wait a few seconds for the permission indicator to appear
6. Verify that an Allow / Don't Allow permission prompt appears below the assistant's message
6. Click "Allow"
7. Verify that a visual indicator (spinner or progress state) is shown while the tool executes
8. Wait for the tool to return a result
9. Verify that the assistant incorporates the tool result into a coherent, formatted response
10. Send a second message that triggers a non-permission-gated tool call (e.g. "Search the web for latest macOS release")
11. Verify that the tool executes without a permission prompt
12. Verify that the assistant response includes citations or references from the tool result

## Expected

- Permission-gated tool calls show a context message followed by an Allow / Don't Allow prompt
- Clicking "Allow" lets the tool execute successfully
- A visual indicator (spinner, loading state) is displayed during tool execution
- The tool result is returned and rendered within a reasonable time (< 10 seconds for simple operations)
- The assistant weaves the tool result into a natural response, not just a raw dump
- Non-permission-gated tools (e.g. web_search) execute without prompting the user
- No crashes, hangs, or orphaned loading states after tool completion
- The conversation remains interactive and the input field is ready for the next message
