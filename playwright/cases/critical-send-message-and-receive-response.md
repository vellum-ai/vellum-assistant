---
fixture: desktop-app
status: critical
---

# Send a Message and Receive a Response

## Goal

Verify that the core assistant loop works: the user can send a message and receive a coherent response from the assistant.

## Steps

1. Launch the app
2. Ensure an assistant is hatched and active
3. Type a message in the input field (e.g. "Hello, who are you?")
4. Press Enter or click the Send button
5. Observe the response area

## Expected

- The message is accepted and displayed in the conversation
- The assistant begins generating a response within a reasonable time (< 3 seconds)
- A complete, coherent response is rendered in the conversation
- The input field is cleared and ready for the next message after sending
