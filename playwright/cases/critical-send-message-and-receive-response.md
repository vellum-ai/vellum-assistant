---
fixture: desktop-app
status: critical
---

# Send a Message and Receive a Response

## Goal

Verify that the core assistant loop works: the user can send a message, receive a coherent streamed response, and send a follow-up.

## Steps

1. Launch the app
2. Ensure an assistant is hatched and active
3. Type a message in the input field (e.g. "Explain how large language models work in detail")
4. Press Enter or click the Send button
5. Observe the response as it streams in
6. Wait for the stream to complete
7. Send a follow-up message and verify the assistant responds

## Expected

- The message is accepted and displayed in the conversation
- The assistant begins generating a response within a reasonable time (< 3 seconds)
- The response streams progressively (tokens appear incrementally, not all at once after a delay)
- No flickering, layout shifts, or broken markdown during streaming
- The final response is complete and coherent, not cut off mid-sentence
- The input field is cleared and ready for the next message after streaming completes
- A follow-up message can be sent and responded to normally
