---
name: agentmail
description: Run email operations through a provider-agnostic CLI wrapper
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📬"
  vellum:
    display-name: "Email CLI Ops"
    user-invocable: true
---

## How to run

`vellum` is your own CLI binary — it is already installed and available on the PATH.
Run all commands via `bash`. Do NOT attempt to install, build, or locate the CLI — just execute it directly.

Example: `bash("assistant email status --json")`

Never use browser/computer-use unless user explicitly approves fallback.

## When to Use This Skill

This skill manages the **assistant's own** AgentMail address (`@agentmail.to`) — not the user's personal email. Only use this skill when the user explicitly asks the assistant to send email **from the assistant's own address**, manage the assistant's inbox, or perform operations on the assistant's AgentMail account. Generic email requests ("send an email", "check my email", "draft a reply") are about the **user's Gmail** and should be handled by the Messaging skill instead.

## Rules

- Always run `assistant email` commands via `bash` and parse JSON output.
- Always do `assistant email status --json` preflight first.
- Prefer `draft create` before any send — never bypass draft flow.
- Require explicit user confirmation before `draft approve-send --confirm`.
- When uncertain, draft to ops@ inbox and notify user.
- Never send cold outreach without explicit user authorization.

## API Key Setup

If `assistant email status --json` returns an error about a missing API key, prompt the user for their AgentMail API key using the secure credential prompt. **Never ask the user to paste the key in chat.**

Use `credential_store` with:
- action: `prompt`
- service: `agentmail`
- field: `api_key`
- label: `AgentMail API Key`
- description: `Get your API key from console.agentmail.to`
- placeholder: `am_us_...`
- allowed_tools: `["bash"]`
- usage_description: `AgentMail email operations via vellum CLI`

After the credential is stored, retry `assistant email status --json` to confirm it works.

## Workflow

1. **Preflight:** `assistant email status --json` (if API key error, run API Key Setup above)
2. **Quick inbox:** `assistant email inbox create --username <name>` (creates e.g. sam@agentmail.to — no custom domain needed)
3. **Custom domain setup (optional):** domain -> dns -> verify -> inboxes -> webhook
4. **Draft path:** `assistant email draft create ...` — always draft first
5. **Send path:** show draft -> user confirms -> `draft approve-send --draft-id <id> --confirm`
6. **Inbound triage:** list -> get -> summarize -> propose reply draft
7. **Guardrails:** check with `guardrails get`, use `guardrails set` to change

## Command Reference

### Provider

```
assistant email provider get [--json]                         # Show active provider
assistant email provider set <provider> [--json]               # Switch provider
```

### Status

```
assistant email status [--json]                               # Provider health + guardrails
```

### Inbox Management

```
assistant email inbox create --username <name> [--domain <d>] [--display-name <n>] [--json]   # Create a new inbox (e.g. --username sam)
assistant email inbox list [--json]                                                            # List all inboxes
```

### Setup

```
assistant email setup domain --domain <d> [--dry-run] [--json]
assistant email setup dns --domain <d> [--json]
assistant email setup verify --domain <d> [--json]
assistant email setup inboxes --domain <d> [--json]                                            # Creates standard hello@/support@/ops@ inboxes
assistant email setup webhook --url <u> [--secret <s>] [--json]
```

### Drafts

```
assistant email draft create --from <addr> --to <addr> --subject <s> --body <b> [--cc <addr>] [--in-reply-to <msg-id>] [--json]
assistant email draft list [--status pending|approved|sent|rejected] [--json]
assistant email draft get <draft-id> [--json]
assistant email draft approve-send --draft-id <id> --confirm [--json]
assistant email draft reject --draft-id <id> [--reason <text>] [--json]
assistant email draft delete <draft-id> [--json]
```

### Inbound

```
assistant email inbound list [--thread-id <id>] [--json]
assistant email inbound get <message-id> [--json]
```

### Threads

```
assistant email thread list [--json]
assistant email thread get <thread-id> [--json]
```

### Guardrails

```
assistant email guardrails get [--json]
assistant email guardrails set --paused <true|false> --daily-cap <n> [--json]
assistant email guardrails block <pattern> [--json]
assistant email guardrails allow <pattern> [--json]
assistant email guardrails rules [--json]
assistant email guardrails unrule <rule-id> [--json]
```

## Output Format

All commands output JSON (pretty-printed by default, compact with `--json`).
Every response includes `ok: true|false`.

Exit codes:
- `0` = success (`ok: true`)
- `1` = error (`ok: false, error: "..."`)
- `2` = guardrail blocked (`ok: false, error: "outbound_paused|daily_cap_reached|address_blocked"`)
