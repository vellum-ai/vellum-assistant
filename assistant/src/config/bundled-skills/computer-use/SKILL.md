---
name: "Computer Use"
description: "Computer-use action tools for controlling the macOS desktop via accessibility and screen capture."
user-invocable: false
disable-model-invocation: true
---

This skill provides the 12 computer_use_* action tools used by ComputerUseSession
to control the macOS desktop. It is internally preactivated for computer-use sessions
and is not available in text sessions.

Tools in this skill are proxy tools — execution is forwarded to the connected
macOS client, never handled locally by the daemon.
