---
name: computer-use
description: Control a connected desktop
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🖥️"
  vellum:
    display-name: "Computer Use"
    category: "system"
    activation-hints:
      - "User asks the assistant to click, type, or interact with the desktop GUI directly"
      - "User wants control of a desktop app with no CLI or API alternative (games, design tools, visual workflows)"
      - "User wants screenshots or visual inspection of what is currently on screen"
    avoid-when:
      - "Task can be done via a more specific skill (gmail, calendar, contacts, terminal-sessions) or a CLI / API call"
---

This skill provides the computer_use_* action tools for controlling a
connected desktop. CU tools run through the main agent loop via HostCuProxy.

The skill is internally preactivated for conversations with a connected desktop client.

Tools in this skill are proxy tools. Execution is forwarded to a connected
desktop client and is never handled locally by the assistant.

## Observations

Every computer-use step returns the accessibility tree. Every action also
returns a screenshot taken after it ran (one at the end of a
`computer_use_sequence`), so check it to see what your action did. An
observation comes with a screenshot on a desktop's first look, when it is
window-scoped, or when you pass `include_screenshot: true`. Ask for one whenever
the tree is not enough to act on: a canvas, a game, a custom-drawn view, few or
unlabeled controls, or a layout question.

The tree is walked to a limited depth to keep steps fast, and says when it was
cut off. If the element you need is not in it, call `computer_use_observe` with
`full_tree: true`.

## Typing is not sending

Pressing enter in a chat, email or form usually sends or submits it, and that
cannot be taken back. Send only when the user asked you to send, post or
submit. When they asked you to type, write or draft something, type it and stop
before pressing enter; tell them it is ready to send.

## Batching known steps (macOS)

When you already know the next few actions and none depends on seeing the
result of the one before, send them as one `computer_use_sequence` call, for
example opening a new window, typing a URL and pressing enter. Act one step at
a time whenever the next action depends on what the screen shows.

## Window-scoped observation (macOS)

`computer_use_observe` accepts optional `capture_window_id`, a native macOS
CGWindowID (not a browser tab ID or accessibility element ID). Obtain the ID
from a current native window inventory before using it; never guess one.
The native helper captures that window and its accessibility tree without
including secondary windows, even when another app covers the selected window.
A missing window must not be replaced with a desktop capture.

This is a **single observation**, not a session-wide privacy boundary: normal
click/type/scroll and other action tools still observe the whole desktop. Do not promise app-only capture for a whole control session.
The desktop must explicitly advertise `host_cu_window_capture` support on its
connection; the daemon rejects older or unsupported clients before requesting
any capture. Other desktop platforms reject this option.

The screenshot is window-relative, while action coordinates are screen points;
do not scale it using full-display dimensions. Prefer accessibility element IDs
and ensure the intended window is focused before a later action. Window-scoped
observation does not focus the window or confine subsequent input to that app.
