---
fixture: desktop-app
status: critical
---

# Streaming Response

## Goal

Verify that the assistant streams responses token-by-token in real time without hanging, cutting off, or rendering incorrectly.

## Steps

1. Launch the app
2. Ensure an assistant is hatched and active
3. Send a message that will produce a long response (e.g. "Explain how large language models work in detail")
4. Observe the response as it streams in
5. Verify that tokens appear progressively in the conversation UI (not all at once after a delay)
6. Wait for the stream to complete
7. Verify that the final response is complete and not truncated
8. Send a follow-up message immediately after the stream completes
9. Verify that the input field accepts input and the assistant responds correctly

## Expected

- Tokens begin appearing in the UI within 3 seconds of sending the message
- The response renders progressively and visibly streams (not a single delayed render)
- No flickering, layout shifts, or broken markdown during streaming
- The stream completes without hanging or timing out
- The final message is complete and coherent, not cut off mid-sentence
- The input field is disabled or clearly non-interactive while streaming
- After streaming completes, the input field becomes active again immediately
- A follow-up message can be sent and responded to normally
