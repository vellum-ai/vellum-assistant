---
title: Host Mode
---

## Overview

In **Host Mode**, the user runs tmux sessions on their own host machine. The assistant connects to those sessions remotely using `host_bash` — specifically via `tmux capture-pane` (to read output) and `tmux send-keys` (to send commands).

Use this mode when the work requires host access that the sandbox can't provide. For tmux operational details (quoting, scrollback, naming, etc.) see [tmux-best-practices.md](tmux-best-practices.md).

## How It Works

1. The user starts a tmux session on their machine (manually or via the `tt` helper — see [User-Facing Scripts](#user-facing-scripts) below).
2. The assistant reads and writes to those sessions through `host_bash`.
3. Sessions are independent of the sandbox — they persist even if the assistant is not running.

## When to Use Host Mode

- **SwiftUI / Xcode builds:** Xcode and the iOS simulator only run on macOS and need the real host filesystem and GPU.
- **Host-local services:** Databases, emulators, or daemons that are bound to `localhost` on the user's machine.
- **User's existing workflows:** The user already has named sessions running and wants the assistant to observe or interact with them.

## Tools

All operations use `host_bash` to execute tmux commands on the user's machine.

### List sessions

```bash
tmux list-sessions -F '#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{pane_current_command}' 2>/dev/null || echo "NO_SESSIONS"
```

Format the output as a readable table for the user. The `session_attached` field shows whether someone (the user) is currently viewing that session.

### Read session output

```bash
tmux capture-pane -t SESSION_NAME -p -S -200 2>/dev/null || echo "SESSION_NOT_FOUND"
```

The `2>/dev/null || echo "SESSION_NOT_FOUND"` pattern detects missing sessions cleanly. See [tmux-best-practices.md](tmux-best-practices.md) for line count guidance and what to look for in output.

### Send a command to a session

```bash
tmux send-keys -t SESSION_NAME 'COMMAND_HERE' Enter
```

Host Mode adds a shell layer: the command passes through `host_bash` before reaching the tmux session's shell, so variables expand twice.

- **Use single quotes** to prevent `host_bash` from expanding the command before tmux sees it
- **Double expansion:** Variables like `$i` or `$HOME` expand in the host shell first. To send a literal `$` to the session:
  - Escape it: `tmux send-keys -t SESSION 'echo \$HOME' Enter`
  - Or use `send-keys -l` (literal mode) for the text, then `Enter` separately:
    ```bash
    tmux send-keys -t SESSION -l 'for i in 1 2 3; do echo "$i"; done'
    tmux send-keys -t SESSION Enter
    ```

See [tmux-best-practices.md](tmux-best-practices.md) for key names, special keys, and wait-before-read patterns.

### Create a new session

```bash
tmux new-session -d -s SESSION_NAME -c WORKING_DIR
```

- `-d` starts it detached (in the background)
- `-s` sets the session name — see [naming conventions](tmux-best-practices.md#session-naming)
- `-c` sets the starting directory (optional but recommended)

### Close a session

```bash
tmux kill-session -t SESSION_NAME
```

Only do this when explicitly asked, or when you're certain a session is no longer needed.

## User-Facing Scripts

This skill ships two helper scripts in [scripts/](../scripts/) that can be installed on the user's host machine.

### `tt` — Quick session launcher

[scripts/tt](../scripts/tt) is a small CLI helper the user runs directly in their terminal:

```
tt                   # List all tmux sessions
tt deploy            # Create or attach to a session named "deploy"
tt deploy ~/myapp    # Create "deploy" in a specific directory
tt -k deploy         # Kill a session
```

This is the recommended way for users to start sessions they want the assistant to see. For example, before starting a Claude Code session: `tt frontend-refactor` then `claude`.

**Install it** by copying to somewhere on the user's PATH. Replace `<skill-dir>` with the actual path to this skill directory (e.g. the workspace `skills/terminal-sessions` path):

```bash
cp <skill-dir>/scripts/tt ~/.local/bin/tt && chmod +x ~/.local/bin/tt
```

Make sure `~/.local/bin` is on PATH (add `export PATH="$HOME/.local/bin:$PATH"` to `.zshrc` if needed).

### `setup-auto-tmux.sh` — Auto-wrap all new shells

[scripts/setup-auto-tmux.sh](../scripts/setup-auto-tmux.sh) adds a hook to the user's shell profile (`.zshrc` or `.bashrc`) that automatically wraps every new interactive shell in a named tmux session. This means every terminal tab/window the user opens becomes visible to the assistant with zero extra effort.

```bash
bash <skill-dir>/scripts/setup-auto-tmux.sh             # Install the hook
bash <skill-dir>/scripts/setup-auto-tmux.sh --uninstall  # Remove the hook
```

The auto-created session names include the terminal app context (`iterm-`, `vscode-`, or `sh-`) plus the TTY and PID for uniqueness. The user can skip auto-tmux for a single shell by setting `VELLUM_NO_AUTO_TMUX=1`.

**Note:** This is more opinionated than `tt` — some users may not want tmux in every shell (different scrollback behavior, keybindings, copy/paste). Offer it as an option, don't push it. `tt` is the lower-friction default.

## Workflow: Connecting to User-Created Sessions

The user may have tmux sessions they started themselves. These are fully accessible — tmux doesn't distinguish between sessions by creator. When the user says "check on my deploy" or "what's happening in my terminal", list all sessions and look for relevant ones.

## Gotchas

- **`host_bash` round-trip latency.** Each operation is a separate IPC call. Batch where possible: send a command, `sleep`, and capture in a single `host_bash` invocation.
- **Double shell expansion.** Commands pass through `host_bash` first, then the tmux shell — see the send-keys section above for how to handle this.
- The user must have tmux installed and a session active before the assistant can connect.
