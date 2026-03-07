---
name: computer-use
description: Computer-use action tools for controlling the macOS desktop via accessibility and screen capture.
compatibility: "Designed for Vellum personal assistants"
metadata: {"emoji":"🖥️","vellum":{"display-name":"Computer Use","user-invocable":false,"disable-model-invocation":true}}
---

This skill provides the 12 computer*use*\* action tools for controlling
the macOS desktop (used by CU sessions).

The `computer_use_request_control` escalation tool is registered in the core
registry (not this skill) so text_qa sessions can execute it directly.

The skill is internally preactivated for computer-use sessions.

Tools in this skill are proxy tools — execution is forwarded to the connected
macOS client, never handled locally by the assistant.
