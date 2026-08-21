---
name: app-control
description: Drive a specific named desktop app via raw input that bypasses the accessibility tree
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🎯"
  vellum:
    display-name: "App Control"
    category: "system"
    feature-flag: "app-control"
    activation-hints:
      - "User explicitly directs the assistant to drive a specific named app via raw input (emulator, game, OpenGL canvas, custom-rendered Electron app)"
      - "User says the desktop accessibility tree is unhelpful or empty for the target app"
    avoid-when:
      - "Task can be done via the computer-use skill (general desktop UI navigation)"
      - "Task can be done via a CLI / API alternative"
---

This skill exposes the `app_control_*` proxy tools for driving a single
named desktop application via raw keyboard, mouse, and screenshot input that
bypasses the system accessibility tree. Use it only when explicitly directed
to a specific app where the accessibility tree is unhelpful (emulators, games,
OpenGL canvases, custom-rendered Electron apps). For general desktop UI navigation
prefer the `computer-use` skill.

Tools in this skill are proxy tools. Execution is forwarded to a connected
desktop client and is never handled locally by the assistant.

## Cadence

Take 2-3 actions per turn, then yield with a short narration so the user can
interject. Do not chain long sequences without surfacing what you are doing.

## Always observe before acting

Call `app_control_observe` before your first input action whenever the screen
state matters (e.g. you need to know what is on screen, where a UI element is,
or whether the app is even running). Re-observe after actions that may have
moved the window or changed visibility.

`observe` waits a short settle delay (default ~200ms) before capturing so the
target app and the desktop compositor can flush pending input and render a fresh
frame. If the captured screenshot looks one input behind the latest state
(common with emulators or other slow-feedback apps), pass a larger
`settle_ms`. For static UIs where you just want a quick snapshot, pass
`settle_ms: 0` to skip the wait.

## Input choice

- Prefer `app_control_sequence` over multiple back-to-back `app_control_press`
  calls when sending an ordered batch of presses (e.g. menu navigation,
  repeated movement). Sequence runs in a single round-trip. The target app is
  activated once at the start and the keys are sent serially without any
  window for keyboard focus to drift to another app between presses. Each step
  may carry its own `duration_ms` (hold) and `gap_ms` (pause after).
- Prefer `app_control_combo` over rapid sequential `app_control_press` for
  simultaneous inputs. `combo` holds every key at once;
  sequential presses interleave key-down and key-up events.
- Use `app_control_type` for literal text into a focused field.

## Coordinate caveat

`app_control_click` and `app_control_drag` use **window-relative** coordinates.
The window may move or resize between observation and click. If you are
uncertain whether the window has shifted, re-observe first.

## App targeting

Use a stable application identifier when one is available. Fall back to the
localized process name when the platform does not provide one.

## Ending the session

Call `app_control_stop` when you are done. Do **not** auto-quit the controlled
app. `stop` only ends the app-control session, leaving the app running.
