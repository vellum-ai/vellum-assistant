---
name: "Computer Use"
description: "Computer-use action tools for controlling the macOS desktop via accessibility and screen capture."
user-invocable: false
disable-model-invocation: true
---

This skill provides the 13 computer_use_* tools: 12 action tools for controlling
the macOS desktop (used by CU sessions) and the `computer_use_request_control`
escalation tool (used by text_qa sessions to hand off to foreground computer use).

The skill is internally preactivated for computer-use sessions. The escalation
tool is also projected into text_qa sessions via `buildToolDefinitions()`.

Tools in this skill are proxy tools — execution is forwarded to the connected
macOS client, never handled locally by the daemon.
