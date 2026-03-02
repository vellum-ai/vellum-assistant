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
3. Share a piece of information with the assistant (e.g. "My favorite color is green" or "I have a meeting with Alex on Friday")
4. Verify the assistant acknowledges and confirms the information
5. Quit the app completely
6. Relaunch the app
7. Ask the assistant to recall the information shared in the previous session (e.g. "What's my favorite color?" or "Do you remember my meeting?")
8. Verify the assistant recalls the correct information

## Expected

- The assistant saves the shared information to long-term memory during the first session
- After relaunch, the assistant loads memory correctly on startup
- The assistant recalls the previously shared information accurately in the new session
- No memory corruption or stale/incorrect data is returned
- If memory recall fails, the assistant communicates gracefully rather than hallucinating or crashing
