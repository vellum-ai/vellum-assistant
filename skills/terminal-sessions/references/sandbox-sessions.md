---
title: Sandbox Mode
---

## Overview

In **Sandbox Mode**, the assistant runs tmux sessions inside its own sandbox environment. The user can attach to any of these sessions live via the Vellum terminal UI.

This is the **default mode** for Claude Code orchestration tasks and any work that doesn't require access to the user's host machine. For tmux operational details (quoting, scrollback, naming, etc.) see [tmux-best-practices.md](tmux-best-practices.md).

## How It Works

1. The assistant creates and manages tmux sessions using the standard `Bash` tool (no `host_bash` needed).
2. Sessions persist for the lifetime of the sandbox — across multiple turns of the same conversation.
3. The user can observe any session in real time by running:

   ```
   vellum terminal attach <session-name>
   ```

   This opens a live, read-write terminal view of that session in the Vellum UI.

## Benefits

- **Always-on:** Sessions survive between assistant turns; the assistant can start a long-running build and check back later without the session disappearing.
- **No host dependency:** The user doesn't need tmux installed locally. No install step, no PATH configuration.
- **No permission races:** Because the assistant owns the sandbox, it can create, read, and write sessions without waiting for `host_bash` approval on each command.
- **Low setup friction:** Works immediately in any Vellum Claude Code session with no configuration.

## Typical Usage

```bash
# Create a session for a long-running dev server
tmux new-session -d -s frontend -c /workspace/myapp
tmux send-keys -t frontend 'npm run dev' Enter

# Check on it after a few turns
tmux capture-pane -t frontend -p -S -50

# User attaches to watch live output in Vellum terminal:
# vellum terminal attach frontend
```

## When to Use Sandbox Mode

- Claude Code orchestration (running builds, tests, dev servers while the conversation continues)
- Tasks where the assistant needs to start a process and poll it over multiple turns
- Any work that doesn't need access to files, tools, or services that only exist on the user's host
