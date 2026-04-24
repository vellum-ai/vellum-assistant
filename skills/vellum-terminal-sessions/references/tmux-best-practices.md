---
title: tmux Best Practices
---

Operational guidance that applies to both [Sandbox Mode](sandbox-sessions.md) and [Host Mode](host-sessions.md).

## send-keys

```bash
tmux send-keys -t SESSION_NAME 'COMMAND_HERE' Enter
```

- `Enter` at the end is a literal tmux key name — it submits the command
- To send special keys: `C-c` (Ctrl+C), `C-d` (Ctrl+D), `C-z` (Ctrl+Z), `Up`, `Down`, `Tab`
- To cancel a running process: `tmux send-keys -t SESSION_NAME C-c`

**Quoting:** Prefer single quotes or no quotes in sent commands. Double quotes can produce mismatched quoting in the target shell.

**Non-ASCII chars.** Em dashes, smart quotes, and emoji can get mangled through shell layers. Stick to plain ASCII when sending commands.

## Reading output

```bash
tmux capture-pane -t SESSION_NAME -p -S -200
```

- Adjust `-S -N` to control line count. `-S -50` is usually enough for a status check; `-S -200` for detailed output.
- Use `-S -` to capture the full scrollback buffer (can be very large).

When reading, look for:

- Error messages or stack traces
- Progress indicators (percentages, spinners, counts)
- Prompts waiting for input
- Exit codes or completion messages

**Wait before reading.** After sending a command, `sleep 1` or `sleep 2` before capturing so it has time to execute:

```bash
tmux send-keys -t SESSION_NAME 'make build' Enter && sleep 2 && tmux capture-pane -t SESSION_NAME -p -S -50
```

**Watch for prompts.** If output shows `[Y/n]` or a password prompt, surface it to the user — don't blindly send input.

## Session naming

- Use short, descriptive names: `deploy`, `frontend`, `api-server`, `claude-refactor`
- Avoid spaces and special characters
- **Dots and colons confuse tmux's target syntax.** Stick to alphanumeric and hyphens.

## Scrollback limits

tmux defaults to 2000 lines of scrollback. For long-running processes, redirect output to a file so nothing important scrolls off:

```bash
long-running-command | tee /tmp/output.log
```

## Multi-pane targeting

This skill creates single-pane sessions by default. If a session has multiple panes, target a specific one with:

```bash
tmux capture-pane -t SESSION_NAME:WINDOW.PANE -p -S -50
tmux send-keys -t SESSION_NAME:WINDOW.PANE 'command' Enter
```
