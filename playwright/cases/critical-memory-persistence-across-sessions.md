---
fixture: desktop-app
status: critical
---

# Memory Persistence Across Sessions

## Goal

Verify that the assistant saves memories during a session and recalls them correctly in a subsequent session.

## Steps

1. Launch the app
2. Ensure an assistant is hatched and active
3. In the current chat, share a piece of information with the assistant (e.g. "My favorite color is green" or "I have a meeting with Alex on Friday")
4. Verify the assistant acknowledges and confirms the information
5. Open a new chat session (without quitting the app)
6. In the new chat, ask the assistant to recall the information shared in the previous chat (e.g. "What's my favorite color?" or "Do you remember my meeting?")
7. Verify the assistant recalls the correct information

## Expected

- In the new chat, the assistant recalls the previously shared information accurately (not stale or fabricated)
- If memory recall fails, the assistant communicates gracefully rather than hallucinating or crashing
