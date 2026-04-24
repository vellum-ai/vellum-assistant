---
name: headless-claude-code
description: Reference guide for running Claude Code in headless, container, and CI environments — covers auth strategies, interactive mode pitfalls, tmux orchestration, root user workarounds, and git auth without SSH agents or keychains
compatibility: "Any environment running Claude Code headlessly"
metadata:
  emoji: "🖥️"
  vellum:
    display-name: "Headless Claude Code"
---

# Headless Claude Code

Running Claude Code outside a desktop terminal — in Docker containers, CI runners, cloud
VMs, or orchestrated by another process — is full of undocumented friction. This guide
covers everything we've learned getting CC to work reliably in these environments.

---

## 1. Authentication

CC tries multiple auth strategies in a fixed priority order. Understanding this chain is
the key to headless auth.

### Priority Order (highest → lowest)

1. **Cloud provider ambient credentials** — AWS Bedrock, GCP Vertex (auto-detected)
2. **`ANTHROPIC_AUTH_TOKEN`** — raw bearer token for Anthropic's API
3. **`ANTHROPIC_API_KEY`** — direct API key (pay-per-token, no Pro subscription features)
4. **`apiKeyHelper`** — executable that prints a token to stdout (set via `--settings`)
5. **`CLAUDE_CODE_OAUTH_TOKEN`** — OAuth token (Pro/Team subscription)
6. **`/login`** — interactive browser OAuth dance (unusable in headless)

### Recommended: `apiKeyHelper`

The most flexible headless strategy. Point CC at a script that returns a valid token:

```json
{
  "apiKeyHelper": "/path/to/your-auth-script"
}
```

Pass it via `--settings /path/to/settings.json` on launch. CC calls this script whenever
it needs a token, so it handles rotation naturally.

**Example helper** (reads from a credential vault):

```bash
#!/bin/bash
# Prints the OAuth token to stdout. CC calls this on demand.
your-vault-cli get anthropic-oauth-token
```

The script MUST:

- Print exactly one token to stdout (no trailing newline issues — CC trims)
- Exit 0 on success
- Be executable (`chmod +x`)

### `setup-token` (One-Time OAuth Bootstrap)

If you have a browser _somewhere_ (your laptop, a jump host), you can bootstrap OAuth
credentials into a headless machine:

```bash
# On the headless machine:
claude setup-token
# Prints a URL and waits for a token

# Open that URL in any browser, complete the OAuth flow.
# The token is saved to ~/.claude/ and CC uses it going forward.
```

This is good for initial setup but tokens expire. For long-running environments,
`apiKeyHelper` with a refresh mechanism is more robust.

### `CLAUDE_CODE_OAUTH_TOKEN` env var

Set a Pro/Team subscription OAuth token directly:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="oat-..."
claude
```

This is the simplest headless auth method and works in both `-p` mode and interactive
mode. The main limitation: no automatic refresh. When the token expires, CC dies.

**Caveat**: on first launch in interactive mode, CC may still show the login method
picker even with this env var set. Complete onboarding once (see Section 2) and
subsequent launches will use the token without prompting.

### What NOT to Use

- **`ANTHROPIC_API_KEY`** works but bills per-token (no Pro subscription). Fine for CI
  where you want predictable billing; bad for long interactive sessions.
- **`/login`** (the interactive browser flow) requires a real browser. In containers,
  this hangs or errors. The whole point of this guide is avoiding it.

---

## 2. First-Run Onboarding & Interactive Prompts

CC has several interactive prompts that block on first launch. In headless environments
where no human is watching, these are silent killers.

### The Onboarding Gauntlet

On first launch, CC may prompt for:

1. **Theme selection** — light/dark/system theme picker
2. **Trust dialog** — "Do you trust the files in this directory?"
3. **Bypass-permissions warning** — safety acknowledgment (when using `--dangerously-skip-permissions`)
4. **OAuth login** — browser-based auth (if no token is configured)

Each of these blocks the process waiting for input. In a tmux session or piped context,
CC just hangs silently.

### Pre-Seeding `.claude.json` (Skip Almost Everything)

CC stores onboarding and trust state in `$HOME/.claude.json`. Pre-populate it to skip
all skippable prompts:

```python
import json, os

config_path = os.path.expanduser("~/.claude.json")
config = {}

# Skip theme picker + welcome screen
config["hasCompletedOnboarding"] = True

# Pre-accept workspace trust per directory
config["projects"] = {
    "/workspace/my-repo": {
        "hasTrustDialogAccepted": True
    }
}

with open(config_path, "w") as f:
    json.dump(config, f, indent=2)
```

This eliminates the theme picker, welcome screen, and trust dialog. The only prompt
that can't be pre-seeded is the **bypass-permissions safety warning** — CC always shows
it when `--dangerously-skip-permissions` is used. Auto-accept it with:

```bash
# After launching CC in tmux, wait for it to render, then:
sleep 5
tmux send-keys -t session_name Down    # Select "Yes, I accept"
tmux send-keys -t session_name Enter
```

### Why Not `-p` (Print Mode)?

`claude -p "prompt"` seems ideal for headless use, but it has critical limitations:

- **Buffers ALL output** until completion — no streaming, no progress visibility
- **No session continuity** — each invocation is a fresh session with no memory
- **No mid-flight interaction** — can't course-correct or add context

Interactive mode in tmux is better for anything beyond one-shot queries. You get
streaming output, session continuity, and can inject follow-up prompts via
`load-buffer`/`paste-buffer` (see Section 3).

---

## 3. tmux Orchestration

For persistent headless sessions, tmux is the right primitive. But the integration has
sharp edges.

### Prompt Injection: `load-buffer` + `paste-buffer`, NOT `send-keys`

**This is the single most important tmux pattern.** Do not use `send-keys` to type
prompts into CC. Special characters, quotes, newlines, and shell metacharacters all
break unpredictably.

```bash
# ✅ CORRECT — works with any content
echo "Your prompt here, with 'quotes' and \"escapes\" and $variables" > /tmp/prompt.txt
tmux load-buffer /tmp/prompt.txt
tmux paste-buffer -t session_name
tmux send-keys -t session_name Enter

# ❌ WRONG — breaks on quotes, newlines, $, !, etc.
tmux send-keys -t session_name "Fix the bug in auth.ts" Enter
```

`send-keys` is fine for simple strings (`Enter`, `Y`, `N`) but not for arbitrary
prompt text. The `load-buffer`/`paste-buffer` pattern treats the content as raw text,
bypassing all shell interpretation.

### Reading Output: `capture-pane`

```bash
# Last 50 lines of a session
tmux capture-pane -t session_name -p -S -50

# Full scrollback to a file
tmux capture-pane -t session_name -p -S - > /tmp/session-output.txt
```

### Session Lifecycle

```bash
# Create a detached session in a working directory
tmux new-session -d -s my-session -c /path/to/repo

# Kill when done
tmux kill-session -t my-session

# List all sessions
tmux list-sessions
```

### Reference Launcher: `cc-session`

A complete launcher that handles auth, user switching, onboarding bypass, git tokens,
and the bypass-permissions warning — zero human interaction required:

```bash
#!/bin/bash
# cc-session <name> [working-dir] [-- claude-args...]
set -euo pipefail

SESSION_NAME="${1:?Usage: cc-session <name> [working-dir]}"
WORK_DIR="${2:-/path/to/default/repo}"

# Install tmux if missing (containers lose it on restart)
command -v tmux &>/dev/null || apt-get install -y -qq tmux

# Find or create a non-root user
CC_USER=$(grep -E '/bin/(ba)?sh$' /etc/passwd | grep -v '^root:' | head -1 | cut -d: -f1)
[ -z "$CC_USER" ] && { useradd -m ccuser; CC_USER="ccuser"; }
CC_HOME=$(eval echo "~$CC_USER")

# Pre-seed .claude.json to skip onboarding + trust prompts
mkdir -p "$CC_HOME/.claude"
python3 -c "
import json
config = {'hasCompletedOnboarding': True, 'projects': {'$WORK_DIR': {'hasTrustDialogAccepted': True}}}
with open('$CC_HOME/.claude.json', 'w') as f: json.dump(config, f)
"
chown -R "$CC_USER:$CC_USER" "$CC_HOME/.claude" "$CC_HOME/.claude.json"

# Write a wrapper script (keeps the token out of tmux scrollback)
LAUNCHER="/tmp/.cc-launch-$SESSION_NAME.sh"
cat > "$LAUNCHER" << EOF
#!/bin/bash
export PATH="/path/to/bun/bin:\$PATH"
export HOME=$CC_HOME
export CLAUDE_CODE_OAUTH_TOKEN="\$(your-vault-cli get anthropic-token)"
cd $WORK_DIR
exec claude --dangerously-skip-permissions
EOF
chmod +x "$LAUNCHER"

# Create session and launch
tmux new-session -d -s "$SESSION_NAME" -c "$WORK_DIR"
sleep 1
tmux send-keys -t "$SESSION_NAME" "su -s /bin/bash $CC_USER -c $LAUNCHER" Enter

# Poll for bypass-permissions warning and auto-accept
for i in $(seq 1 30); do
  tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null | grep -q "Yes, I accept" && {
    tmux send-keys -t "$SESSION_NAME" Down; sleep 0.3; tmux send-keys -t "$SESSION_NAME" Enter; break
  }; sleep 1
done

# Poll for ready prompt
for i in $(seq 1 20); do
  tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null | grep -q "bypass permissions on" && break
  sleep 1
done
```

Key design decisions:

- **Wrapper script** instead of `send-keys` exports — token never appears in scrollback
- **Polling loops** instead of fixed `sleep` — adapts to slow/fast startup
- **Readiness check** — script doesn't return until CC is actually at the prompt

### Reference Prompt Sender: `cc-prompt`

```bash
#!/bin/bash
# cc-prompt <session> <file>    — send file contents as prompt
# cc-prompt <session> -c "text" — send inline text as prompt
set -euo pipefail

SESSION_NAME="$1"; shift

if [ "${1:-}" = "-c" ]; then
  shift
  PROMPT_FILE=$(mktemp)
  echo "$*" > "$PROMPT_FILE"
  CLEANUP=true
else
  PROMPT_FILE="$1"
  CLEANUP=false
fi

tmux load-buffer "$PROMPT_FILE"
tmux paste-buffer -t "$SESSION_NAME"
sleep 0.5
tmux send-keys -t "$SESSION_NAME" Enter

[ "$CLEANUP" = true ] && rm -f "$PROMPT_FILE"
```

---

## 4. Root User & Permissions

Containers often run as root. CC has special behavior here that will bite you.

### `--dangerously-skip-permissions` Refuses Root

CC deliberately refuses `--dangerously-skip-permissions` when running as root (UID 0).
The flag is designed for trusted local development; root + skip-permissions is considered
too dangerous.

```
Error: --dangerously-skip-permissions cannot be used as root
```

### Recommended: Switch to Any Non-Root User

Most container images have at least one non-root user, or you can create one. The key
insight: CC only checks `uid == 0` — any non-root uid works, regardless of the
username or whether the user has a real home directory.

```bash
# Find existing non-root users with a shell
grep -E '/bin/(ba)?sh$' /etc/passwd | grep -v '^root:'

# If none exist, create one
useradd -m ccuser

# Switch and launch
su -s /bin/bash ccuser -c '
  export PATH="/path/to/bun/or/node/bin:$PATH"
  export HOME=/home/ccuser
  export CLAUDE_CODE_OAUTH_TOKEN="your-token"
  claude --dangerously-skip-permissions
'
```

**In a tmux launcher**, the pattern is:

```bash
tmux new-session -d -s my-session -c /workspace
tmux send-keys -t my-session "su -s /bin/bash ccuser" Enter
sleep 1
tmux send-keys -t my-session "export PATH=/path/to/bin:\$PATH" Enter
tmux send-keys -t my-session "export HOME=/home/ccuser" Enter
tmux send-keys -t my-session "export CLAUDE_CODE_OAUTH_TOKEN='$TOKEN'" Enter
tmux send-keys -t my-session "claude --dangerously-skip-permissions" Enter
```

**Important**: set `HOME` explicitly after `su`. Some containers default root's `HOME`
to `/root` or `/data`, and `su` doesn't always update it. CC stores config in `$HOME/.claude`
and `$HOME/.claude.json`, so a wrong `HOME` means it can't find its auth or onboarding
state.

### Alternative: `--settings` with `permissions.allow`

If you can't switch users, pre-approve tools via settings so CC never prompts:

```json
{
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Write(*)", "Edit(*)"]
  }
}
```

Pass via `claude --settings /path/to/settings.json`. This is functionally equivalent
to skip-permissions but works as root. Use only in trusted environments.

### Fallback: Auto-Approve via `send-keys`

When CC asks for permission, send approval:

```bash
# Watch for permission prompts and auto-approve
while true; do
  OUTPUT=$(tmux capture-pane -t session_name -p -S -5)
  if echo "$OUTPUT" | grep -q "Allow\|approve\|permission"; then
    tmux send-keys -t session_name "Y" Enter
  fi
  sleep 2
done
```

This is janky and race-prone. Use it as a last resort.

---

## 5. Git Auth in Containers

Containers don't have SSH agents, keychains, or credential managers. Git auth needs to
be handled explicitly.

### HTTPS with Token in Remote URL

The simplest approach — embed an access token directly in the remote URL:

```bash
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/org/repo.git"
```

Works with:

- GitHub App installation tokens
- Personal access tokens (PATs)
- Fine-grained tokens

### Token Refresh

GitHub App tokens expire (typically 1 hour). For long sessions, refresh before push:

```bash
# Refresh token and update remote
TOKEN=$(your-token-refresh-command)
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/org/repo.git"
git push origin HEAD
```

Build this into your launcher or run it before CC tries to push.

### `gh` CLI Auth

If `gh` is installed, it can handle auth for git operations:

```bash
gh auth setup-git  # configures git credential helper
```

But `gh` itself needs auth — either `GITHUB_TOKEN` env var or `gh auth login` with a
token. In containers, set `GITHUB_TOKEN` and run `gh auth setup-git` during setup.

### What Doesn't Work

- **SSH keys** — no `ssh-agent` in most containers; mounting keys is a security risk
- **macOS Keychain** — obviously not available
- **Git Credential Manager** — requires a credential store that doesn't exist
- **`git credential-store`** — writes plaintext to disk; works but ugly

---

## 6. CC `--settings` Deep Merge Behavior

`--settings` doesn't replace `~/.claude/settings.json` — it deep-merges on top of it.
This means:

- Your `apiKeyHelper` in `--settings` overrides the one in `~/.claude/settings.json`
- Hooks from `~/.claude/settings.json` are preserved
- Array fields (like `permissions.allow`) are merged, not replaced

This is useful: you can have repo-level settings in `~/.claude/settings.json` (hooks,
tool configs) and overlay auth-only settings via `--settings` at launch.

---

## 7. Common Failure Modes

| Symptom                          | Cause                                    | Fix                                                                                |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| CC hangs on launch               | First-run onboarding prompts             | Pre-seed `~/.claude.json` with `hasCompletedOnboarding` + `hasTrustDialogAccepted` |
| CC hangs on launch               | No valid auth token                      | Set `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, or run `setup-token`                |
| "cannot be used as root"         | `--dangerously-skip-permissions` as root | `su` to any non-root user, or use `--settings` with `permissions.allow`            |
| Git push fails: 401              | Token expired                            | Refresh token and update remote URL                                                |
| Git push fails: 403              | Token lacks permissions                  | Check token scopes (need `contents:write`)                                         |
| Prompt text mangled              | Using `send-keys` for complex text       | Use `load-buffer` + `paste-buffer`                                                 |
| `-p` mode: no output for minutes | Print mode buffers everything            | Use interactive mode in tmux instead                                               |
| CC asks for login mid-session    | OAuth token expired                      | Use `apiKeyHelper` with refresh logic                                              |
| `tmux: command not found`        | Container restarted                      | Install tmux in your launcher script                                               |

---

## 8. Quick Start: Container Checklist

```
□ Auth: CLAUDE_CODE_OAUTH_TOKEN env var or apiKeyHelper configured
□ Onboarding: ~/.claude.json pre-seeded (hasCompletedOnboarding + hasTrustDialogAccepted)
□ User: running as non-root (su if needed) for --dangerously-skip-permissions
□ Bypass warning: auto-accepted via send-keys Down+Enter after launch
□ tmux: installed in launcher (won't persist across container restarts)
□ Prompts: injected via load-buffer/paste-buffer (NOT send-keys)
□ Git: token embedded in remote URL, refresh mechanism for long sessions
□ Monitoring: capture-pane for output (not -p buffering)
```
