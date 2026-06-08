---
name: assistant-migration
description: Migrate from ChatGPT, Claude, OpenClaw, Hermes, Manus, and other AI assistants into Vellum by inspecting their data exports, conversation archives, files, prompts, custom instructions, memory, saved memories, tools, GPTs, workflows, integrations, and relationships, then mapping as much as safely possible into Vellum primitives. Handles single-source and multi-source migrations with a unified, deduplicated inventory.
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🧳"
  vellum:
    category: "system"
    display-name: "Assistant Migration"
    includes: ["chatgpt-import"]
    activation-hints:
      - "User wants to migrate from ChatGPT, Claude, OpenClaw, Hermes, Manus, or another AI assistant into Vellum"
      - "User wants to migrate from ChatGPT or Claude into Vellum"
      - "User has a ChatGPT data export ZIP or Claude conversation/summary export"
      - "User has an assistant export, workspace, prompt bundle, memory dump, tool config, or migration request from another assistant system"
      - "User asks what can be preserved when switching from another assistant"
    avoid-when:
      - "User is moving an existing Vellum assistant between Vellum homes; use backup/restore or teleport workflows instead"
---

# Assistant Migration

Help the creator migrate from another AI assistant into Vellum. Preserve as much of the source assistant as can be understood safely, but do not rely on deterministic adapters for OpenClaw, Hermes, Manus, or any other non-Vellum internals. These systems evolve quickly; inspect the actual source artifacts in front of you and map them into Vellum primitives.

## Core Posture

- Migrate internals opportunistically: prompts, memory exports, skill definitions, tool manifests, schedules, app code, workflow docs, MCP configs, browser/computer-use preferences, and integration metadata can often be preserved.
- Do not pretend opaque runtime state is portable. If a file, database row, binary blob, or generated artifact cannot be confidently understood, mark it for review or rebuild.
- Never import secrets from chat, logs, config dumps, browser profiles, or exported files. Secrets must be reconnected through Vellum's credential vault, OAuth flows, or setup skills.
- Do not create scripts or deterministic code that encode assumptions about another assistant's private filesystem or database schema.
- Be inviting. Migration can feel sensitive because the creator may have a real relationship with the source assistant; acknowledge that directly, move at the creator's pace, and keep them in control of what is inspected, imported, reviewed, or left alone.
- Treat every source assistant, source machine, and source export as read-only unless the creator explicitly authorizes a specific write. Before accessing a source machine, say plainly that you will not modify anything there.
- Be transparent with the creator: identify what will be ported, what needs review, what should be disregarded, and what must be re-set up from scratch.

## Getting Access to Source Internals

The creator may not know where their other assistant stores its internals. Help them find the safest available source of truth before asking them to upload or paste data.

Start with low-risk discovery:

- Ask whether the source assistant offers an official export, backup, workspace folder, settings page, or CLI command.
- If the source runs locally, help locate likely workspace/config directories, but avoid scraping browser profiles or secret stores.
- If the source is on another machine, walk the creator through a safe access path such as an archive, read-only share, or temporary SSH access. Make clear that source-machine work is for inspection and copying only: do not install packages, change config, stop services, delete files, write marker files, or run source-assistant commands that mutate state without explicit approval.
- If the source is hosted, guide the creator toward official data export, account settings, project download, repository access, or support-provided archive paths.
- If there is no export path, ask the source assistant to produce portable summaries of its memory, instructions, active workflows, skills, apps, contacts, and integration setup.
- If access requires admin privileges, organization approval, or another person's account, stop and tell the creator what permission they need rather than trying to bypass it.

When internals are hard to access, fall back to an interview-style migration: ask the creator and source assistant for high-signal summaries, then rebuild in Vellum with review.

Before copying large folders or attachments, estimate source size and check available space in the current Vellum workspace. Use available storage diagnostics or shell filesystem probes when available, migrate large assets in batches, and pause for the creator if the import could crowd the workspace or trigger disk-pressure cleanup.

### Per-assistant references

Once the source assistant is identified, consult the matching reference for the exact data-directory layout, a bundling recipe with explicit `--exclude` flags for secret-bearing paths, and the after-import rebind checklist:

- [ChatGPT → Vellum](references/chatgpt.md)
- [Claude → Vellum](references/claude.md)
- [Hermes → Vellum](references/hermes.md)
- [OpenClaw → Vellum](references/openclaw.md)

For ChatGPT conversation history specifically, do not parse export ZIPs here — invoke the `chatgpt-import` skill, which owns the export-and-parse flow. The ChatGPT reference covers only the non-conversation material (custom instructions, saved memories, GPT configs).

These are reconnaissance notes, not adapters. They tell you where to look and what to leave behind. The preferred flow is a single `tar` archive that the creator uploads to the conversation as a chat attachment. Never run `curl`, `wget`, or any other fetcher against a URL the creator pastes in chat — a chat-supplied URL substituted into a shell command is a confused-deputy surface (shell substitution inside double quotes, SSRF against private networks, and a bypass of the platform's structured URL-safety checks). See [`references/README.md`](references/README.md) for the shared tar-and-transport model and the rules each per-assistant reference must follow.

## Migration Workflow

### 1. Establish the Source and Migration Goal

Ask only for missing essentials:

- Source assistant and artifact location: export file, workspace directory, repository, archive, screenshots, or copied text.
- Desired fidelity: quick usable migration, careful review-first migration, or exhaustive salvage.

If the user already provided enough context, start inspecting.

### 2. Inventory Before Importing

Build an inventory grouped by Vellum primitive. For each candidate item, capture:

- Source path or origin.
- What it appears to be.
- Suggested Vellum destination.
- Confidence: high, medium, or low.
- Recommended action: port, review first, re-setup, or disregard.
- Reason for the recommendation.

Do not mutate Vellum state until the creator has reviewed the inventory unless they explicitly asked for an immediate best-effort migration.

#### Multi-source migrations

When the creator names more than one source ("I used ChatGPT and Claude", "ChatGPT plus my old OpenClaw box"), build **one unified inventory**, not one per source. Each inventory row gains a **Source attribution** column alongside the existing fields (source path/origin, what-it-is, Vellum destination, confidence, action, reason).

Dedupe and reconcile across sources:

- When the same fact, memory, identity trait, contact, or skill appears from multiple sources, collapse it to a **single Vellum item**.
- Record all contributing sources in the item's provenance notes so the creator can audit where it came from.
- On conflict, prefer the **higher-confidence or more-recent** source. Surface genuine conflicts to the creator rather than silently picking one.
- Credentials from every source are never imported; they rebind through the vault regardless of which source they came from.

The unified inventory drives **per-source rebind/import routing** — each row's action resolves against the source it came from:

- ChatGPT conversation archives → the `chatgpt-import` skill (see below; do not parse ZIPs here).
- Claude exports / self-summaries → [`references/claude.md`](references/claude.md).
- OpenClaw / Hermes / Manus and other local-workspace assistants → their existing references.
- ChatGPT non-conversation material (custom instructions, saved memories, GPT configs) → [`references/chatgpt.md`](references/chatgpt.md).

Keep the existing Review Surface and Port / Review / Re-setup / Disregard flow. Multi-source just means **one combined checklist with source labels**, not a separate pass per source.

### 3. Present a Review Surface

Prefer a rich checklist when an interactive surface is available. The checklist should let the creator mark each item as:

- **Port**: bring it into Vellum now.
- **Review**: inspect in more depth before importing.
- **Re-setup**: recreate through Vellum setup flows because direct import is unsafe or impossible.
- **Disregard**: leave it behind.

If a rich UI is not available on the current channel, present the same information as a concise markdown table and ask for the creator's choices.

Suggested checklist groups:

- Identity and personality
- Memory and relationship knowledge
- Conversations and attachments
- Skills, tools, MCP, browser, and computer-use capabilities
- Apps, widgets, dashboards, and custom UIs
- Channels, clients, contacts, and guardian verification
- Integrations, OAuth apps, credentials, and secrets
- Trust rules, approvals, and permission expectations
- Schedules, heartbeats, watchers, followups, and task queues
- Workspace files, projects, notes, and persistent artifacts
- Inference profiles and provider connections

### 4. Port What Maps Cleanly

Use the most native Vellum primitive available. Prefer existing Vellum setup/import flows over custom conversion. Keep source provenance in notes when useful so the creator can audit where migrated material came from.

For each migrated group, report what changed and what remains pending. If an item is skipped, say why.

### 5. Rebuild What Cannot Be Safely Ported

Some internals should be rebuilt instead of copied:

- API keys, tokens, cookies, and browser sessions.
- Provider-specific OAuth refresh tokens.
- Foreign approval policies whose semantics do not match Vellum trust rules.
- Opaque vector stores, caches, embeddings, hidden chain-of-thought, or model traces.
- Runtime-specific process state, queues, locks, or binary databases that are not documented.
- Capabilities that depend on a foreign tool runtime unavailable in Vellum.

When rebuilding, explain the Vellum equivalent and ask whether the creator wants to re-set it up now.

## Vellum Primitive Map

| Source assistant concept                              | Vellum primitive                                             | Migration guidance                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Name, persona, tone, identity docs, system prompts    | Identity, Personality, Avatar, `SOUL.md`, user persona files | Preserve explicit creator-approved identity/personality material. Convert brittle prompt hacks into plain behavioral guidance.                  |
| Current focus, scratchpads, working notes             | `NOW.md`, Workspace notes, Memory                            | Preserve active projects and open loops. Avoid importing stale scratch state as permanent truth.                                                |
| Memory databases, summaries, profiles, user facts     | Memory                                                       | Prefer source-produced summaries or human-readable exports. Preserve attribution where possible. Use review for inferred or sensitive facts.    |
| Conversation history                                  | Conversations and Memory                                     | Import supported structured exports when available. Otherwise summarize useful history into memory candidates rather than dumping logs blindly. |
| Tools, skills, commands, plugins, playbooks           | Skills                                                       | Recreate as Vellum skills when the capability is still useful. Keep instructions portable; avoid foreign runtime assumptions.                   |
| MCP servers                                           | MCP                                                          | Recreate server registrations and required environment through Vellum's MCP setup flow. Reconnect secrets through the credential vault.         |
| Browser automation state, browsing tasks              | Browser capability                                           | Recreate workflows and permissions. Do not import cookies or browser profile secrets directly.                                                  |
| Computer-use automations                              | Computer Use capability                                      | Recreate task intent and permission expectations. Verify host-computer access through Vellum's own consent model.                               |
| Custom dashboards, tools, visual workflows            | Apps or Widgets                                              | Persistent interactive tools should become Apps. Transient conversation UI should become Widgets or normal chat flows.                          |
| Slack, Telegram, email, phone, webhooks               | Channels and Integrations                                    | Reconnect channels through Vellum setup skills. Expect some providers, especially Slack, to need fresh setup.                                   |
| Friends, coworkers, allowed users                     | Contacts and Trusted Contacts                                | Map relationships into Contacts. Grant channel access through trusted-contact and guardian flows, not direct database edits.                    |
| Owner/admin identity, approval authority              | Guardian Verification                                        | Verify the creator/guardian on each channel needed for secure access and approvals.                                                             |
| Secrets, API keys, tokens, OAuth refresh tokens       | Credential Vault and OAuth Integrations                      | Never paste or import raw secrets. Rebind through secure prompts, OAuth connect flows, or provider setup skills.                                |
| Autonomy settings, allowlists, deny rules             | Trust Rules and Permissions                                  | Translate intent, not syntax. Start conservative when semantics are unclear.                                                                    |
| Timed jobs and reminders                              | Schedules                                                    | Recreate one-shot and recurring tasks using Vellum schedules. Preserve the user-visible intent and delivery channel.                            |
| Autonomous monitors and polling jobs                  | Watchers                                                     | Rebuild as watchers when the source monitors external events. Reconnect provider credentials first.                                             |
| Periodic self-checks                                  | Heartbeats                                                   | Use Vellum heartbeats for agenda-free self-checking, not for specific timed jobs.                                                               |
| Pending replies or nudges                             | Followups                                                    | Preserve expected-response workflows as followups when the source tracks sent messages awaiting replies.                                        |
| Reusable action templates and queues                  | Task Queue                                                   | Recreate repeatable work as tasks or queued work items when the creator expects review before completion.                                       |
| Model routing, fast/quality/cost modes, provider keys | Inference Profiles and Provider Connections                  | Map source behavior to named profiles such as balanced, quality, or cost/speed variants. Reconnect provider credentials safely.                 |
| Files, projects, notes, attachments                   | Workspace                                                    | Copy useful, non-secret artifacts into the Vellum workspace with clear organization. Leave local worktree artifacts and foreign caches behind.  |

## Memory Import Guidance

When the source assistant can answer questions, invite it to produce a portable self-summary instead of scraping every internal file. Ask for comprehensive but reviewable output:

- Identity and background.
- Preferences and communication style.
- Important relationships.
- Active projects and open loops.
- Durable instructions the creator gave it.
- Meaningful history from recent conversations.
- Uncertainties and low-confidence inferences clearly labeled.

Then present the summary as memory candidates for creator review. Do not silently save sensitive, speculative, or emotionally loaded claims.

## Internals Salvage Guidance

When source files are available, inspect them directly and classify them:

- **High-confidence portable**: markdown, JSON/YAML config with clear labels, prompt files, skill docs, app source, workflow docs, schedules, contact lists, exported conversations.
- **Medium-confidence portable**: SQLite tables with obvious names, tool manifests, MCP configs, integration metadata without secrets, memory summaries with unclear provenance.
- **Low-confidence or non-portable**: embeddings, vector indexes, binary stores, caches, encrypted blobs, cookies, refresh tokens, queue state, process supervision files, undocumented schema fragments.

For medium- and low-confidence items, ask before importing and prefer converting into reviewed notes or setup tasks.

## Final Migration Report

End with a concise report:

- Ported successfully.
- Needs creator review.
- Needs re-setup in Vellum.
- Disregarded or intentionally left behind.
- Residual risk: anything uncertain, sensitive, or not yet verified.

If the migration created follow-up work, offer the next concrete step rather than claiming the migration is complete.
