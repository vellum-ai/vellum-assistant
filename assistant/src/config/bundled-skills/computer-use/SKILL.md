---
name: computer-use
description: Control a connected or virtual desktop
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

This skill provides the computer_use_* action tools through the main agent
loop and its shared computer-use history, step budget, and screenshot handling.

Choose `target: "assistant-desktop"` on every call to control the streamed
Virtual desktop on an enabled platform-hosted assistant. Omitted targets and
`target: "connected-computer"` control the user's connected computer. Use
`target_client_id` to choose among connected computers; do not combine it with
`assistant-desktop`. Targets never fall back to a different computer.

## Virtual desktop

Use `computer_use_observe` with `target: "assistant-desktop"` first. Every successful step
returns a full desktop screenshot and an `observation_id`. Pass that ID with
the next action (or sequence); it is consumed once. Observe again after browser
actions, user handoff, errors, or interruption. There is no accessibility tree, so use
screen coordinates from that screenshot.
Click, type, key, scroll, drag, wait, and sequences share the browser automation
session, cancellation, and user handoff. First use installs desktop components
and starts the same desktop shown in the Virtual desktop panel.

Use Linux shortcuts such as `ctrl+l`. Open apps through the dock or desktop UI;
`open_app`, AppleScript, element IDs, and window-scoped capture are unavailable.
Call `computer_use_done` with the same target when finished to release the session. Prefer
`assistant browser` for browser tasks that do not need desktop interaction.

## Observations

On connected personal computers, every computer-use step returns the
accessibility tree. Every action also returns a screenshot taken after it ran (one at the end of a
`computer_use_sequence`), so check it to see what your action did. An
observation comes with a screenshot on a desktop's first look, when it is
window-scoped, or when you pass `include_screenshot: true`. Ask for one whenever
the tree is not enough to act on: a canvas, a game, a custom-drawn view, few or
unlabeled controls, or a layout question.

The tree is walked to a limited depth to keep steps fast, and says when it was
cut off. If the element you need is not in it, call `computer_use_observe` with
`full_tree: true`.

## Scripting apps (macOS)

Reach for `computer_use_run_applescript` first when an app can be driven by
script. It does not take the cursor.

**Try the app's own scripting dictionary before anything else.** Ask it for the
state you want, not for the clicks that would produce that state. Finder, Mail,
Music, Notes, Safari, Terminal and many third-party apps have one, and where
there is a dictionary the whole task is usually a sentence with no window to
open, no tree to read and nothing to click:

```applescript
tell application "Finder"
  set target of front window to desktop
  set current view of front window to list view
  set sort column of list view options of front window to name column
end tell
```

**System Events menu clicking is the fallback**, for apps with no dictionary
entry for what you need: `click menu item "Split Clip" of menu "Modify" of menu
bar 1` inside `tell application "System Events" to tell process "iMovie"`. It is
UI automation in a script's clothes: it still depends on the menu sitting where
you expect and on the app being frontmost. A menu item that needs a selection or
a playhead position does nothing when that context is missing, so set it up
first, and read `enabled of menu item` when unsure.

Click and type for everything a script cannot reach. `host_bash` is for shell
commands, not for driving apps.

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
