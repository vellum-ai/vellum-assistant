---
name: "Email CLI Ops"
description: "Run email operations through a provider-agnostic CLI wrapper"
user-invocable: true
metadata: {"vellum": {"emoji": "📬"}}
---

## How to run

Run all commands via `host_bash`. The CLI is your own binary — do NOT attempt to install it.

To find the correct invocation, run this discovery command first:
```
host_bash("command -v vellum 2>/dev/null && echo 'USE: vellum' || echo \"USE: bun run $(ps -p $(pgrep -f 'daemon/main.ts' | head -1) -o args= 2>/dev/null | sed 's|^bun run ||;s|daemon/main.ts|index.ts|')\"")
```

- If the output says `USE: vellum`, use `vellum email ...` for all commands.
- If the output says `USE: bun run /path/to/index.ts`, use that prefix instead of `vellum` (e.g., `bun run /path/to/index.ts email status --json`).

Store the resolved prefix and reuse it for the rest of the session. Do NOT re-discover on every command.

Never use browser/computer-use unless user explicitly approves fallback.

## Rules

- Always run `vellum email` commands via `host_bash` and parse JSON output.
- Always do `vellum email status --json` preflight first.
- Prefer `draft create` before any send — never bypass draft flow.
- Require explicit user confirmation before `draft approve-send --confirm`.
- When uncertain, draft to ops@ inbox and notify user.
- Never send cold outreach without explicit user authorization.

## Workflow

1. **Preflight:** `vellum email status --json`
2. **Setup (first-time):** domain -> dns -> verify -> inboxes -> webhook
3. **Draft path:** `vellum email draft create ...` — always draft first
4. **Send path:** show draft -> user confirms -> `draft approve-send --draft-id <id> --confirm`
5. **Inbound triage:** list -> get -> summarize -> propose reply draft
6. **Guardrails:** check with `guardrails get`, use `guardrails set` to change

## Command Reference

### Provider

```
vellum email provider get [--json]                         # Show active provider
vellum email provider set <provider> [--json]               # Switch provider
```

### Status

```
vellum email status [--json]                               # Provider health + guardrails
```

### Setup

```
vellum email setup domain --domain <d> [--dry-run] [--json]
vellum email setup dns --domain <d> [--json]
vellum email setup verify --domain <d> [--json]
vellum email setup inboxes --domain <d> [--json]
vellum email setup webhook --url <u> [--secret <s>] [--json]
```

### Drafts

```
vellum email draft create --from <addr> --to <addr> --subject <s> --body <b> [--cc <addr>] [--in-reply-to <msg-id>] [--json]
vellum email draft list [--status pending|approved|sent|rejected] [--json]
vellum email draft get <draft-id> [--json]
vellum email draft approve-send --draft-id <id> --confirm [--json]
vellum email draft reject --draft-id <id> [--reason <text>] [--json]
vellum email draft delete <draft-id> [--json]
```

### Inbound

```
vellum email inbound list [--thread-id <id>] [--json]
vellum email inbound get <message-id> [--json]
```

### Threads

```
vellum email thread list [--json]
vellum email thread get <thread-id> [--json]
```

### Guardrails

```
vellum email guardrails get [--json]
vellum email guardrails set --paused <true|false> --daily-cap <n> [--json]
vellum email guardrails block <pattern> [--json]
vellum email guardrails allow <pattern> [--json]
vellum email guardrails rules [--json]
vellum email guardrails unrule <rule-id> [--json]
```

## Output Format

All commands output JSON (pretty-printed by default, compact with `--json`).
Every response includes `ok: true|false`.

Exit codes:
- `0` = success (`ok: true`)
- `1` = error (`ok: false, error: "..."`)
- `2` = guardrail blocked (`ok: false, error: "outbound_paused|daily_cap_reached|address_blocked"`)
