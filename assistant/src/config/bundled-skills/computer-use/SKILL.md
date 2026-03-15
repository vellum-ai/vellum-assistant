---
name: computer-use
description: Computer-use action tools for controlling the macOS desktop via accessibility and screen capture.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🖥️"
  vellum:
    display-name: "Computer Use"
---

This skill provides the computer_use_* action tools for controlling
the macOS desktop. CU tools run through the main agent loop via HostCuProxy.

The skill is internally preactivated for sessions with a connected desktop client.

Tools in this skill are proxy tools — execution is forwarded to the connected
macOS client, never handled locally by the assistant.
