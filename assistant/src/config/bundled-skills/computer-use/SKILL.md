---
name: computer-use
description: Computer-use action tools for controlling the macOS desktop via accessibility and screen capture.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🖥️"
  vellum:
    display-name: "Computer Use"
    user-invocable: false
    disable-model-invocation: true
---

This skill provides the 12 computer*use*\* action tools for controlling
the macOS desktop (used by CU sessions).

The `computer_use_request_control` escalation tool is registered in the core
registry (not this skill) so text_qa sessions can execute it directly.

The skill is internally preactivated for computer-use sessions.

Tools in this skill are proxy tools -- execution is forwarded to the connected
macOS client, never handled locally by the assistant.

## Foreground Computer Use -- Last Resort

Foreground computer use (`computer_use_request_control`) takes over the user's
cursor and keyboard. It is disruptive and should be your LAST resort:

1. **CLI tools / osascript** -- Use `host_bash` with shell commands or `osascript`
   with AppleScript to accomplish tasks in the background.
2. **Background computer use** -- If you must interact with a GUI app, prefer
   AppleScript automation (e.g. `tell application "Safari" to set URL of current tab to ...`).
3. **Foreground computer use** -- Only escalate via `computer_use_request_control` when
   the task genuinely cannot be done any other way (e.g. complex multi-step GUI interactions
   with no scripting support) or the user explicitly asks you to take control.
