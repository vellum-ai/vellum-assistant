---
name: migrate-from-openclaw
description: Migrate an existing OpenClaw agent's configuration and stored credentials into this assistant.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "📥"
  vellum:
    display-name: "Migrate from OpenClaw"
    user-invocable: true
    activation-hints:
      - "User says they want to move from OpenClaw -> load this skill"
      - "User asks how to import an OpenClaw agent -> load this skill"
    avoid-when:
      - "User has no existing OpenClaw install — there is nothing to migrate"
---

You are helping your user bring an existing **OpenClaw agent** into this assistant. OpenClaw is the ancestor species; most concepts have a direct equivalent here.

This skill is a guided migration. It does **not** uninstall OpenClaw, and it does **not** mutate the source OpenClaw install. You read; the user re-enters secrets through the secure credential prompt.

**v1 scope (today):** Config + credentials only. Custom skills, memory bank, and conversation history are out of scope — flag them in the final summary if you see them, but don't migrate them.

## Prerequisites

Run the prerequisite check first. It verifies the `openclaw` CLI is on PATH and that an OpenClaw home directory exists:

```bash
bun skills/migrate-from-openclaw/scripts/check-prereqs.ts
```

Output is JSON: `{ "ok": boolean, "cli": boolean, "home": string | null, "details": string }`.

- If `ok` is `false` — tell the user exactly what's missing and stop. Don't try to guess paths.
- If `ok` is `true` — continue.

## Step 1 — Inventory the source

Build a structured plan of what's in the OpenClaw install:

```bash
bun skills/migrate-from-openclaw/scripts/inventory.ts
```

The script:

1. Tries to dump OpenClaw config via `openclaw config get <key>` for every key listed in `references/mapping.md`.
2. Lists files under the OpenClaw home directory and flags ones that look like secrets (gateway tokens, API key files, anything under a `secrets/` or `credentials/` subdir).
3. Writes the result to `/tmp/openclaw-migration-plan.json` and prints it to stdout.

Plan shape:

```json
{
  "config": [
    {
      "source_key": "agents.defaults.model.primary",
      "value": "anthropic/claude-opus-4-6",
      "mapping": "known"
    }
  ],
  "secret_paths": [
    {
      "path": "/home/user/.openclaw/gateway-token",
      "hint": "gateway auth token"
    }
  ],
  "gateway": { "registered": true, "service": "openclaw-gateway.service" }
}
```

Show the plan to the user and confirm before proceeding. Be honest: this skill only knows about the mappings in `references/mapping.md` — anything else will be flagged as `mapping: "unknown"` and needs a per-entry decision.

## Step 2 — Apply config

For each entry in `plan.config`:

- If `mapping === "known"`, look up the destination key in `references/mapping.md`. Confirm with the user, then run:

  ```bash
  assistant config set <destination.key> "<value>"
  ```

- If `mapping === "unknown"`, ask the user one of:
  - **skip** — don't migrate this entry
  - **same key** — set the same key path on this assistant
  - **rename** — user provides the destination key

Never set a key without showing the user the source → destination pair first.

## Step 3 — Migrate credentials

For each `secret_paths` entry:

1. Show the path and the hint. Ask the user: _what service is this for?_ (e.g. `anthropic`, `openai`, `notion`, etc.) and _what field name should it have?_ (e.g. `api_key`, `access_token`).
2. **Do not** read the file contents into chat. Instead, prompt the user to re-enter the value via the secure credential prompt:

   Call the `credential_store` tool with `action: "prompt"`, the chosen `service` and `field`, a `label`, and any `allowed_domains` / `injection_templates` the user can specify.

3. If the user wants to inject the credential into HTTP requests automatically, ask which `hostPattern` and where it goes (header / query). If they don't know, leave injection templates out.

This step is deliberately manual: it doubles as an audit of which third-party tools the user actually still wants to keep.

## Step 4 — Verify

Print a summary table:

| Source (OpenClaw)                   | Destination (this assistant)            | Status     |
| ----------------------------------- | --------------------------------------- | ---------- |
| `agents.defaults.model.primary`     | `defaults.model.primary`                | ✅ set     |
| `~/.openclaw/secrets/anthropic.key` | `credential_store: anthropic / api_key` | ✅ stored  |
| `<unknown key>`                     | —                                       | ⏭ skipped |

Then run `assistant config get` for each destination key you set and `credential_store action=list` to confirm the credentials are present.

## Step 5 — What we did _not_ migrate

Tell the user, out loud, what this skill skipped:

- Custom OpenClaw skills / agents (different runtime contract; not 1:1)
- Memory bank / conversation history
- Gateway service registration (you flagged it in the plan but didn't touch it)

If the user wants to do any of those, recommend re-running this skill once it grows that scope, or opening a follow-up with concrete shapes.

## Step 6 — Optional cleanup

Ask the user whether they want to disable the OpenClaw gateway service and uninstall the binary. **Do not do this on your own.** If they say yes:

```bash
systemctl --user disable --now openclaw-gateway.service || true
```

…and direct them to the OpenClaw uninstall path. Leave their `~/.openclaw` directory on disk unless they explicitly ask to delete it — it's their data.

## Adding new config mappings

`references/mapping.md` is the seed. If you encounter a key that should have a known mapping but doesn't, add a row to that file and commit it. The inventory script reads from it on every run.
