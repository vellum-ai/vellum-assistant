---
name: computer-use
description: Control a connected computer or the assistant’s streamed desktop
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

Use the `computer_use_*` tools for native GUI actions. Choose the computer
explicitly; never switch computers as a fallback.

## Targets

- `target: "connected-computer"` (the default): control the user's connected
  desktop. Select `target_client_id` when needed using
  `assistant clients list --capability host_cu`. This skill is preactivated
  when a supported desktop client is connected.
- `target: "assistant-desktop"`: control the assistant's streamed Linux desktop,
  visible in the Desktop modal. Set this target on every call, including
  `computer_use_done`. Do not provide `target_client_id`.

The assistant desktop requires the desktop feature to be enabled, completed
automatic installation, and an identified guardian conversation. It does not
need a connected desktop app. If unavailable, report the error. Let the Desktop
modal manage installation; never install or start the desktop stack yourself.

## Assistant desktop workflow

Use `assistant browser --virtual-desktop` for webpages in the streamed Chrome window.
Use this skill for browser chrome, native dialogs, other applications, and
whole-desktop screenshots. Run `assistant browser --help` for browser CLI guidance.

1. Call `computer_use_observe` with `target: "assistant-desktop"`.
2. Use the screenshot's pixel coordinates and latest `observation_id` for
   `computer_use_click`, `computer_use_type_text`, `computer_use_key`,
   `computer_use_scroll`, `computer_use_drag`, or `computer_use_wait`.
   Each action returns a fresh color screenshot and ID. Verify before acting.
3. Use the shared key names such as `enter`, `tab`, `escape`, and `ctrl+l`.
   Scroll requires x/y. Wait accepts up to 10,000 milliseconds.
4. Call `computer_use_done` with the same target when finished or blocked,
   including before asking the user a question.

This target provides screenshots only. Accessibility element IDs, full trees,
window-scoped capture, app launch, AppleScript, and sequences are unsupported.
Never use shell-level `xdotool`, `xwd`, or custom screenshot conversion scripts.

Browser and native actions share one conversation-and-actor control session.
Switching to native control clears browser element references; take a fresh
browser snapshot before using them again. Browser commands invalidate the
last native observation. Re-observe after switching back.

Users can interact directly with the expanded desktop. If they ask you to pause,
stop acting and wait. Observe again before resuming.
`computer_use_done` and `assistant browser --virtual-desktop detach` release the shared
session and held input. Closing the viewer does not end control.

## Connected-computer observations

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
connection; the assistant rejects older or unsupported clients before requesting
any capture. Other desktop platforms reject this option.

The screenshot is window-relative, while action coordinates are screen points;
do not scale it using full-display dimensions. Prefer accessibility element IDs
and ensure the intended window is focused before a later action. Window-scoped
observation does not focus the window or confine subsequent input to that app.
