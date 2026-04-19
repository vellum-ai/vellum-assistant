---
name: terminal-sessions
description: Manage persistent terminal sessions via tmux. Create, read, write to, list, and close named shell sessions. Use when the user asks about running terminal processes, wants help orchestrating CLI tasks, or asks you to monitor or interact with long-running commands. Also use when the user mentions tmux sessions.
compatibility: "Requires tmux installed on the host machine. Works on macOS and Linux."
metadata:
  emoji: "🖥️"
  author: vellum-ai
  version: "0.1"
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

This skill gives you the ability to manage **persistent terminal sessions** on the user's host machine via tmux. Unlike `host_bash` (which runs one-shot commands), terminal sessions persist across commands — you can start a process, check on it later, and send follow-up commands.

This is especially useful for:

- **Monitoring long-running processes** (builds, deploys, dev servers)
- **Orchestrating multiple CLI agents** (e.g. several Claude Code sessions)
- **Running interactive commands** that need follow-up input

## Prerequisites

- **tmux** must be installed on the host. Check with: `host_bash: which tmux`
- If not installed, offer to install it: `host_bash: brew install tmux` (macOS) or `host_bash: sudo apt install tmux` (Linux)

## Tools

All operations use `host_bash` to execute tmux commands on the host machine.

### List sessions

Show all active tmux sessions:

```bash
tmux list-sessions -F '#{session_name}|#{session_created}|#{session_windows}|#{session_attached}|#{pane_current_command}' 2>/dev/null || echo "NO_SESSIONS"
```

Format the output as a readable table for the user. The `session_attached` field shows whether someone (the user) is currently viewing that session.

### Read session output

Capture recent output from a session (last 200 lines by default):

```bash
tmux capture-pane -t SESSION_NAME -p -S -200 2>/dev/null || echo "SESSION_NOT_FOUND"
```

Adjust `-S -N` to control how many lines to capture. Use `-S -` to capture the entire scrollback buffer (can be very large).

When reading, look for:

- Error messages or stack traces
- Progress indicators (percentages, spinners, counts)
- Prompts waiting for input
- Exit codes or completion messages

### Send a command to a session

```bash
tmux send-keys -t SESSION_NAME 'COMMAND_HERE' Enter
```

**Important notes:**

- Use single quotes around the command to avoid shell expansion in the `host_bash` layer
- **But beware double expansion:** the command string is interpreted by the host shell _and_ then by the tmux session's shell. Variables like `$i` or `$HOME` will expand in the host shell before tmux sees them. To send literal variables/special chars to the session, either:
  - Escape the dollar sign: `tmux send-keys -t SESSION 'echo \$HOME' Enter`
  - Or use `tmux send-keys -l` (literal mode) for text, then send `Enter` separately:
    ```bash
    tmux send-keys -t SESSION -l 'for i in 1 2 3; do echo "$i"; done'
    tmux send-keys -t SESSION Enter
    ```
- The `Enter` at the end is a literal tmux key name — it presses Enter
- To send special keys: `C-c` (Ctrl+C), `C-d` (Ctrl+D), `C-z` (Ctrl+Z), `Up`, `Down`, `Tab`
- To cancel a running process: `tmux send-keys -t SESSION_NAME C-c`
- After sending a command, **wait a moment then read** to see the result:
  ```bash
  tmux send-keys -t SESSION_NAME 'echo hello' Enter && sleep 1 && tmux capture-pane -t SESSION_NAME -p -S -20
  ```

### Create a new session

```bash
tmux new-session -d -s SESSION_NAME -c WORKING_DIR
```

- `-d` starts it detached (in the background)
- `-s` sets the session name
- `-c` sets the starting directory (optional but recommended)

**Naming conventions:**

- Use descriptive, short names: `deploy`, `frontend`, `api-server`, `claude-refactor`
- Avoid spaces and special characters in names

### Close a session

```bash
tmux kill-session -t SESSION_NAME
```

Only do this when explicitly asked, or when you're certain a session is no longer needed.

## User-Facing Scripts

This skill ships two helper scripts in [scripts/](scripts/) that can be installed on the user's host machine.

### `tt` — Quick session launcher

[scripts/tt](scripts/tt) is a small CLI helper the user runs directly in their terminal:

```
tt                   # List all tmux sessions
tt deploy            # Create or attach to a session named "deploy"
tt deploy ~/myapp    # Create "deploy" in a specific directory
tt -k deploy         # Kill a session
```

This is the recommended way for users to start sessions they want the assistant to see. For example, before starting a Claude Code session: `tt frontend-refactor` then `claude`.

**Install it** by copying to somewhere on the user's PATH:

```bash
cp SKILL_DIR/scripts/tt ~/.local/bin/tt && chmod +x ~/.local/bin/tt
```

Make sure `~/.local/bin` is on PATH (add `export PATH="$HOME/.local/bin:$PATH"` to `.zshrc` if needed).

### `setup-auto-tmux.sh` — Auto-wrap all new shells

[scripts/setup-auto-tmux.sh](scripts/setup-auto-tmux.sh) adds a hook to the user's shell profile (`.zshrc` or `.bashrc`) that automatically wraps every new interactive shell in a named tmux session. This means every terminal tab/window the user opens becomes visible to the assistant with zero extra effort.

```bash
bash SKILL_DIR/scripts/setup-auto-tmux.sh             # Install the hook
bash SKILL_DIR/scripts/setup-auto-tmux.sh --uninstall  # Remove the hook
```

The auto-created session names include the terminal app context (`iterm-`, `vscode-`, or `sh-`) plus the TTY and PID for uniqueness. The user can skip auto-tmux for a single shell by setting `VELLUM_NO_AUTO_TMUX=1`.

**Note:** This is more opinionated than `tt` — some users may not want tmux in every shell (different scrollback behavior, keybindings, copy/paste). Offer it as an option, don't push it. `tt` is the lower-friction default.

## Workflow: Orchestrating Multiple Sessions

A common pattern is managing several parallel work streams:

1. **List** what's running: get session names and current commands
2. **Read** each one to understand status
3. **Summarize** for the user: "Frontend build is done, API tests are at 73%, deploy is waiting for confirmation"
4. **Act** on the user's instructions: "approve the deploy", "restart the failed test", etc.

When the user asks something like "how are my sessions doing?", do a full sweep:

1. `tmux list-sessions` to get all names
2. `tmux capture-pane` on each one (last 30-50 lines is usually enough for status)
3. Synthesize a concise status report

## Workflow: Connecting to User-Created Sessions

The user may have tmux sessions they started themselves. These are fully accessible — tmux doesn't distinguish between sessions by creator. When the user says "check on my deploy" or "what's happening in my terminal", list all sessions and look for relevant ones.

## Tips

- **Don't spam reads.** If you just sent a command, `sleep 1` or `sleep 2` before reading to let it execute.
- **Watch for prompts.** If a read shows a `[Y/n]` or password prompt, tell the user rather than blindly sending input.
- **Scrollback limits.** tmux defaults to 2000 lines of scrollback. For very long-running processes, important output may have scrolled off. Consider redirecting output to a file (`cmd | tee /tmp/output.log`) for critical processes.
- **Multiple panes.** This skill uses single-pane sessions for simplicity. If the user has multi-pane setups, target specific panes with `-t SESSION_NAME:WINDOW.PANE`.
- **Session names with dots or colons** can confuse tmux's target syntax. Stick to alphanumeric and hyphens.
- **Avoid non-ASCII characters in send-keys.** Unicode chars (em dashes, smart quotes, emoji) can get mangled through the shell layers and break quoting. Stick to plain ASCII when sending commands.
- **Prefer unquoted or single-quoted strings in sent commands.** Double quotes sent via `send-keys -l` can produce mismatched quoting in the target shell. If the command doesn't need quoting, skip it: `echo hello world`. If it does, prefer single quotes on the target side.
