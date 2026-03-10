---
fixture: desktop-app
status: experimental
---

# Permission Denial Handling

## Goal

Verify that when a user clicks "Don't Allow" on a tool permission prompt, the assistant handles the denial gracefully without crashing or becoming unresponsive.

## Steps

1. Launch the App
2. On the welcome screen, click the "Self-host" button (not "Sign in")
3. Enter your Anthropic API key and complete the self-host setup so the assistant is ready
4. Once in the chat, send a message that triggers a tool requiring permission, such as "create a file called test.txt on my Desktop"
5. Wait for a permission prompt to appear **inline in the chat** — it will show buttons like "Allow Once", "Always Allow", and "Don't Allow" directly within the conversation
6. Click the "Don't Allow" button on the inline permission prompt. Do NOT navigate to Settings or any other panel — the button is right there in the chat
7. Verify that the assistant acknowledges the denial and continues operating normally
8. Send a follow-up message like "hello" to confirm the chat is still responsive

## Expected

- The app should not crash or freeze after the permission is denied
- The assistant should acknowledge that the tool was not allowed and respond gracefully
- The chat should remain fully functional after the denial
