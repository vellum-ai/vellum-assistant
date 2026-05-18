---
name: hermes-migration
description: Migrate a Hermes Agent (Nous Research) installation into a Vellum personal assistant by inspecting its workspace, SQLite store, skills, memories, schedules, channels, and provider configuration, then mapping each piece into the closest Vellum primitive without porting opaque internals.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🦅"
  vellum:
    display-name: "Hermes Migration"
    feature-flag: species-migration
    activation-hints:
      - "User wants to migrate from Hermes Agent (Nous Research) into Vellum"
      - "User mentions ~/.hermes, hermes setup, hermes gateway, Nous Portal, or a Hermes export"
      - "User asks what carries over from Hermes when switching to Vellum"
    avoid-when:
      - "User is migrating from a different species (OpenClaw, Manus, etc.) — defer to species-migration"
      - "User is moving an existing Vellum assistant between homes — use backup/restore or teleport flows"
---

# Hermes Migration

Help the creator move a Hermes Agent installation into Vellum. Hermes and Vellum share enough surface area — agentskills.io skills, persistent memory, multi-platform gateway, MCP, schedules — that a lot can carry across cleanly. Other pieces (Honcho user modeling, learning-loop trajectories, provider keys, opaque SQLite state) must be reviewed or rebuilt.

This skill is the Hermes-specific companion to the generic `species-migration` skill. Use `species-migration` for the review-surface and inventory workflow; use this skill for the concrete Hermes reconnaissance — where data lives, what each table means, what carries over verbatim, what does not.

## Posture

- **Source is read-only.** Never run `hermes config set`, `hermes update`, `hermes doctor --fix`, or any command that mutates the source installation. Never edit `~/.hermes/` files. Copying out, reading, and inspecting are fine; writing back to the Hermes install is not.
- **Secrets never travel through chat.** API keys, OAuth refresh tokens, gateway tokens, and provider credentials stay in Hermes' store; they get re-bound in Vellum through the credential vault and OAuth flows. Do not paste, screenshot, or echo credential values.
- **No deterministic porting scripts.** Hermes ships fast — its SQLite schema, file layout, and config keys change between minor versions. Inspect the actual artifacts in front of you and translate intent, not byte layouts. If you cannot confidently read a file, mark it for review rather than guessing.
- **Be transparent.** The creator may have a real relationship with their Hermes agent. Acknowledge it. Move at their pace. Show what will be imported, what needs review, what is being rebuilt, and what is being left behind.

## Where Hermes Stores Things

Hermes' data directory is the source of truth for everything portable. Locate it before asking the creator for anything they would have to paste.

| Platform              | Default data directory                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Linux                 | `~/.hermes/`                                                                                                               |
| macOS                 | `~/.hermes/`                                                                                                               |
| WSL2                  | `~/.hermes/` (on the Linux side)                                                                                           |
| Termux (Android)      | `~/.hermes/`                                                                                                               |
| Windows native (beta) | `%LOCALAPPDATA%\hermes\`                                                                                                   |
| Docker                | Bind mount, commonly `~/.hermes` ↔ `/root/.hermes` or a project `data/` ↔ `/opt/data`. Inspect the host side of the mount. |

Inside the data directory, expect roughly:

- A SQLite database holding memories, skills metadata, sessions, conversation history, and (in some versions) encrypted provider keys. Hermes uses FTS5 full-text search over conversation/memory tables.
- A `skills/` directory of agentskills.io-format skill folders, each with a `SKILL.md` and optional `scripts/`, `references/`, `assets/`.
- A `config.toml` (or `config.json`, depending on version) holding provider settings, gateway settings, and feature toggles.
- An `AGENTS.md` and/or `CONTEXT.md` at the project root the creator was working from — Hermes loads these as recurring context.
- A `logs/` or `trajectories/` directory of session logs and RL-training trajectory exports.

Run `hermes config get data_dir` if uncertain. If the creator can run `hermes doctor` and share the output, that surfaces the resolved data dir, provider config (with secrets redacted), gateway status, and database health.

## Two Source Modes

### Mode A: Same machine

The Hermes install lives on the same host as Vellum. Inspect files in place; do not modify them. Use file reads, shell `sqlite3` queries, and config dumps.

### Mode B: Remote machine

Hermes runs on a VPS, home server, or workstation the creator owns. Pick the least-invasive access method available:

1. Ask the creator to run `hermes doctor`, `hermes config get`, and a `sqlite3 .schema` against the Hermes DB and paste the output (or attach the file).
2. If they can produce an archive of `~/.hermes/` minus the SQLite WAL and any secret files, that is usually the cleanest path. Help them tar/zip it.
3. SSH access is acceptable when the creator authorizes it. State explicitly: read-only, no `hermes` mutating commands, no package installs, no service restarts.
4. If the database is open and being written to live, ask for a `.backup` SQLite snapshot rather than the raw file.

If none of those are possible, fall back to an **interview migration** — have the source Hermes produce portable summaries of its memory, active skills, schedules, and channel setup, then rebuild in Vellum with review.

Before copying, estimate the source size and check available space in the current Vellum workspace. Hermes trajectory dumps and conversation FTS5 indexes can be large; migrate in batches if space is tight.

## What Maps Cleanly

These translate directly with high confidence:

| Hermes concept                                                                                                                                                                                    | Vellum primitive                                 | Notes                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `skills/*/SKILL.md` (agentskills.io)                                                                                                                                                              | Vellum Skills                                    | Frontmatter is shared (`name`, `description`, `compatibility`, `metadata`, `allowed-tools`). Body Markdown ports as-is. Drop Hermes-specific extensions under `metadata.hermes.*`; add Vellum extensions under `metadata.vellum.*` where useful. |
| Skill `scripts/`                                                                                                                                                                                  | Vellum Skill `scripts/`                          | Portable as long as the dependencies are pinned in import paths (the agentskills.io spec rule). Re-run them in the Vellum sandbox to confirm.                                                                                                    |
| `AGENTS.md` / `CONTEXT.md`                                                                                                                                                                        | Workspace `AGENTS.md`, `SOUL.md`, `NOW.md`       | Hermes loads these as project context across sessions. Split persona/identity into `SOUL.md` and `IDENTITY.md`; keep project-scoped instructions in workspace `AGENTS.md`; move active scratch into `NOW.md`.                                    |
| Hermes memories table                                                                                                                                                                             | Vellum Memory                                    | Prefer summaries the Hermes agent itself produces; if reading the table directly, classify each row as durable fact / preference / relationship / open loop before importing. Drop FTS5 index — Vellum builds its own.                           |
| Conversation history                                                                                                                                                                              | Vellum Conversations + Memory                    | If a structured export is available, import it. Otherwise summarize useful threads into memory candidates rather than dumping raw transcripts.                                                                                                   |
| Schedules / cron entries                                                                                                                                                                          | Vellum Schedules                                 | Hermes' natural-language cron lines translate well; preserve delivery channel, cadence, and the user-visible intent.                                                                                                                             |
| MCP server registrations                                                                                                                                                                          | Vellum MCP                                       | Recreate registrations through Vellum's MCP setup flow. Reconnect secrets through the credential vault, never copy raw values.                                                                                                                   |
| Subagent definitions / pipelines                                                                                                                                                                  | Vellum subagents                                 | Hermes' isolated-subagent pattern (own conversation + terminal + RPC) maps to Vellum's `subagent` skill. Re-create the trigger and tool surface; do not import binary process state.                                                             |
| Messaging gateway accounts (Telegram, Discord, Slack, WhatsApp, Signal, Email, SMS, Matrix, Mattermost, Teams, Google Chat, DingTalk, Feishu, WeCom, Weixin, QQ Bot, BlueBubbles, Home Assistant) | Vellum Channels + Integrations                   | Reconnect each via Vellum's setup skills. Tokens are rebuilt, not copied. Expect Slack and WhatsApp to need a fresh app setup, not just a token swap.                                                                                            |
| Provider list (Nous Portal, OpenRouter, OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, NovitaAI, NVIDIA NIM, Ollama, z.ai/GLM, Kimi/Moonshot, MiniMax, Hugging Face, custom endpoints)         | Vellum Inference Profiles + Provider Connections | Map Hermes' fast/quality split, if configured, into named Vellum profiles. Reconnect provider keys through the credential vault.                                                                                                                 |
| Skill activation routing (`hermes tools` config)                                                                                                                                                  | Vellum skill activation hints + feature flags    | Translate which skills are enabled / disabled / flagged in Hermes into Vellum activation hints and feature-flag state.                                                                                                                           |

## What Needs Review

These can move, but only after the creator looks at them:

- Memory entries inferred by Honcho dialectic user modeling. Hermes' 4th-layer user model is opinionated and accumulates implicit traits; treat each row as a candidate, not a fact. Surface them in the review checklist with clear labeling.
- Skills the Hermes agent created autonomously through the learning loop. They may be excellent, brittle, or specific to the Hermes runtime. Read each one before porting.
- Project-specific `AGENTS.md` content that mixes durable instructions with stale state.
- Followups, pending replies, or open-loop nudges that may already be resolved on the Vellum side.
- Trusted-contact and ACL state. Hermes' gateway has its own allowlists; in Vellum, channel access goes through the guardian/trusted-contact graph.

## What Does Not Carry

Rebuild these in Vellum rather than importing:

- Provider API keys, OAuth refresh tokens, Telegram bot tokens, Discord tokens, Slack tokens, WhatsApp credentials. Bind through the Vellum credential vault.
- Hermes' FTS5 index, embedding caches, vector stores, and any LLM trajectory dumps used for RL training. Vellum manages its own search/memory indexes.
- SQLite WAL/SHM files, lock files, daemon supervision state, and any binary blob the Hermes version doesn't document.
- Honcho's internal state if the creator does not want it imported as memory.
- The `hermes claw migrate` artifacts (OpenClaw→Hermes import logs) — they reference a different species' filesystem and are not useful in Vellum.
- Approval / autonomy policies tied to Hermes' permission model. Translate the **intent** into Vellum trust rules; start conservative when semantics do not match.
- Computer-use sessions and browser cookies. Re-establish through Vellum's host-proxy / computer-use flow with fresh consent.

## Workflow

### 1. Establish source and goal

Ask only what is missing:

- Where does Hermes run — same machine, remote host, container?
- Hermes version (`hermes --version`).
- Migration fidelity — quick best-effort, careful review-first, or exhaustive salvage.

If the creator has already pointed at a `~/.hermes` archive or path, start inspecting.

### 2. Inventory before importing

Walk the data directory and produce an inventory grouped by Vellum primitive. For each candidate, record source path, what it appears to be, suggested Vellum destination, confidence (high/medium/low), recommended action (port / review / re-setup / disregard), and reason.

Common starting probes:

- `sqlite3 <hermes.db> .tables` — confirm table names; Hermes versions diverge here.
- `sqlite3 <hermes.db> .schema memories` and `.schema skills` — read columns; do not assume.
- `cat ~/.hermes/config.toml` — provider list, gateway toggles, data_dir override.
- `ls ~/.hermes/skills/` — port-candidate skill folders.
- `ls ~/.hermes/logs/ | head` — sample sessions for memory summarization.

### 3. Present a review surface

Hand off to the `species-migration` skill for the interactive checklist. Use its Port / Review / Re-setup / Disregard categories. Suggested groups:

- Identity and personality (`AGENTS.md`, project instructions)
- Memory (durable facts, preferences, relationships, open loops)
- Conversations (sampled / summarized)
- Skills (each `skills/*/`)
- Schedules and watchers
- Channels and gateway accounts
- Integrations and provider connections
- Trust rules and approvals
- Workspace files and project artifacts
- Inference profiles

### 4. Port what maps cleanly

Use the most native Vellum primitive available. For skills, drop the folder into the Vellum skills directory and let the catalog refresh pick it up. For schedules, recreate through the schedules flow rather than direct DB insert. For channels, run the per-channel setup skill.

Preserve provenance in notes when useful: a one-line "imported from Hermes 2026.4.30" on a memory or skill helps the creator audit later.

### 5. Rebuild what does not carry

For each rebuild target, name the Vellum equivalent and ask if the creator wants to do it now. Bind credentials through the vault. Re-OAuth providers and messaging platforms.

### 6. Final report

End with: ported successfully, needs review, needs re-setup, disregarded, residual risk. If anything is still open, offer the next concrete step rather than claiming the migration is complete.

## Quick Recon Commands

These are safe, read-only probes the creator (or the assistant on their behalf, with permission) can run against a Hermes install:

```bash
# Resolve data dir
hermes config get data_dir 2>/dev/null || echo "$HOME/.hermes"

# Version + provider summary
hermes --version
hermes doctor

# Skill inventory
ls -1 "$HOME/.hermes/skills/" 2>/dev/null

# SQLite recon (replace path with the resolved DB)
sqlite3 "$HOME/.hermes/hermes.db" ".tables"
sqlite3 "$HOME/.hermes/hermes.db" ".schema"
sqlite3 "$HOME/.hermes/hermes.db" "SELECT COUNT(*) FROM memories;"
sqlite3 "$HOME/.hermes/hermes.db" "SELECT COUNT(*) FROM skills;" 2>/dev/null

# Snapshot for offline review (no WAL, no live writes mid-copy)
sqlite3 "$HOME/.hermes/hermes.db" ".backup '/tmp/hermes-backup.db'"
```

If any of these fail because the schema has shifted, fall back to `.schema` for the actual tables and adapt — do not assume.

## When To Hand Off

- If the creator is migrating from OpenClaw, Manus, or another species, use `species-migration` instead.
- If the creator is moving a Vellum assistant between Vellum homes, use backup/restore or teleport flows.
- If the source is a Hermes-derived fork with materially different storage, treat it as unknown — interview the source agent, do not assume Hermes schema.
