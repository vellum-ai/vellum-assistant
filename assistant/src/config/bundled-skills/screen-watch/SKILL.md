---
name: screen-watch
description: Observe the screen at regular intervals with OCR
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "\U0001F441\uFE0F"
  vellum:
    display-name: "Screen Watch"
---

Start observing the screen at regular intervals for a specified duration. Captures OCR text from the active window and provides periodic commentary.

## Usage

Use `start_screen_watch` when the user wants you to monitor what's happening on their screen. The tool captures OCR text from the active window at configurable intervals and provides commentary based on a specified focus area.

## Parameters

- **focus_area** (required) — What to focus on observing
- **duration_minutes** — How long to watch in minutes (1-15, default 5)
- **interval_seconds** — Seconds between screen captures (5-30, default 10)

## Constraints

- Only one active watch session per conversation at a time
- Duration is clamped to 1-15 minutes
- Capture interval is clamped to 5-30 seconds
