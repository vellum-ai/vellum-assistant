---
name: vellum-terminal-sessions
description: Manage persistent terminal sessions via tmux. Create, read, write to, list, and close named shell sessions. Use when the user asks about running terminal processes, wants help orchestrating CLI tasks, or asks you to monitor or interact with long-running commands. Also use when the user mentions tmux sessions.
compatibility: "Sandbox mode works without any host dependencies. Host mode requires tmux installed on the user's machine. Works on macOS and Linux."
metadata:
  emoji: "🖥️"
  author: vellum-ai
  version: "0.2"
  vellum:
    display-name: "Terminal Sessions"
    activation-hints:
      - "User asks about their running terminal sessions or processes"
      - "User wants to monitor a long-running command"
      - "User wants the assistant to run something in a persistent shell"
      - "User mentions tmux or terminal management"
      - "User wants to orchestrate multiple CLI agents (e.g. Claude Code sessions)"
    avoid-when:
      - "A simple one-shot command that host_bash handles fine"
      - "The user is asking about shell scripting in general, not session management"
---

## Overview

This skill manages **persistent terminal sessions** via tmux. Two modes:

|                       | Sandbox Mode                               | Host Mode                                                           |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| **Where tmux runs**   | In the assistant's sandbox                 | On the user's host machine                                          |
| **How user connects** | `vellum terminal attach <session-name>`    | User opens their own terminal                                       |
| **Assistant access**  | Direct (`bash` tool)                       | Via `host_bash`                                                     |
| **Best for**          | Claude Code orchestration, always-on tasks | Work needing host access (e.g. SwiftUI builds, host-local services) |

**Default:** Use **Sandbox Mode** unless the task specifically requires host access. Details: [sandbox-sessions.md](references/sandbox-sessions.md) · [host-sessions.md](references/host-sessions.md) · [tmux-best-practices.md](references/tmux-best-practices.md)

## Prerequisites

**Sandbox Mode:** No setup needed — tmux is available in the sandbox.

**Host Mode:** Requires tmux on the host — see [host-sessions.md](references/host-sessions.md).

## Workflow: Orchestrating Multiple Sessions

- **List** all sessions: `tmux list-sessions` to get names and current commands
- **Read** each: `tmux capture-pane -t NAME -p -S -50` (30-50 lines is usually enough)
- **Summarize** before acting: "Build done, tests at 73%, deploy waiting for confirmation"
- **Act** on the user's instructions
