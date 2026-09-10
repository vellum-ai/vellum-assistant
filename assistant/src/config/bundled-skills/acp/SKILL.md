---
name: acp
description: Set up, authenticate, and run external coding agents (Claude Code, Codex) via the Agent Client Protocol
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
    category: "development"
    activation-hints:
      - "User names Claude Code or Codex, or wants to set up, install, configure, authenticate, connect, use, or delegate work to them"
      - "User wants an agent to work autonomously and report back later"
      - "User mentions ACP, claude-agent-acp, or codex-acp"
    avoid-when:
      - "The task is small enough to do inline and the user did not name Claude Code or Codex"
---

ACP agent orchestration - spawn external coding agents (Claude Code, Codex) to work on tasks via the Agent Client Protocol. Each agent runs as its own subprocess speaking ACP over stdio and streams results back into the conversation.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

Users can refer to agents by natural names: "claude code", "codex cli", and "openai codex" all resolve to the canonical `claude` and `codex` ids (unless the user's config defines an agent literally keyed by that name, which always wins).

## Choosing a model

Claude runs on Opus unless the user names a model; every other agent starts on its own default.

When the user does name one, pass it as `model` on `acp_spawn`. Model names are the agent's own vocabulary, not Assistant model ids: an alias such as `default`, `sonnet`, `opus`, `haiku`, `fable`, or `opusplan` for Claude, or a full model id. Pass what the user said and let the agent resolve it.

If the agent refuses the model, or advertises no model selector, the spawn result says so: relay it in one sentence and carry on, because the session is live on the agent's own model.

A session runs on the model it started on, so a different model means a new `acp_spawn`. A standing default per agent lives in the config at `acp.agents.<id>.model`.

## When the user names Claude Code or Codex

If they name Claude Code or Codex without asking you to run it here (for example they say that tool will do the work), offer once, in one short sentence, that you can connect and run it in this conversation. Then continue with whatever they were doing.

- Do not spawn unless they accept.
- Skip if you already offered this conversation, they declined, or they are already connected.
- This is not the missing-token card path. Do not invent setup steps.

## First-time setup

ACP is always available - default profiles for `claude` and `codex` ship out-of-box, so no config edit is needed to start. First-time setup is just making the adapter binary available, then spawning:

1. Install the adapter binary if it's missing. This happens automatically: when `acp_spawn` finds the agent's binary missing from PATH, the assistant installs the pinned version via a sandboxed bun global install and proceeds in the same call (see "Automatic adapter availability" below).

2. Call `acp_spawn`. Do NOT run `vellum sleep && vellum wake` - that kills the conversation.

## Automatic adapter availability

When an agent's binary is missing from PATH, the assistant installs the adapter version it was built against via a sandboxed bun global install and then runs the real installed binary. The install runs in a fresh empty temporary directory (never the task's project directory), with known secrets stripped from the installer environment and the registry pinned to the public npm registry, so a malicious project directory cannot hijack package resolution or capture a token.

An adapter already on PATH is left alone, whoever installed it: the install runs only when preflight found no binary at all.

Only the allowlisted out-of-box packages are ever installed this way (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`); user-configured agents with custom commands are never installed automatically.

Manual installation is fallback guidance for unusual setups: bun unavailable, restricted global installs, or an auto-install failure (the failure reason is surfaced in the tool result). Install the pinned version below rather than `@latest`, so the adapter matches what the assistant was built against.

```bash
bun add -g @agentclientprotocol/claude-agent-acp@0.75.1   # claude
bun add -g @agentclientprotocol/codex-acp@1.10.0          # codex
```

## Claude setup

The `claude-agent-acp` adapter requires a Claude **OAuth token** (`sk-ant-oat…`), NOT an API key (`sk-ant-api…`). Every spawn injects the stored token as `CLAUDE_CODE_OAUTH_TOKEN` automatically. The write path rejects an API key in this field, so never direct a user to paste an `sk-ant-api…` key here.

**Primary: the in-app Connect Claude Code flow.** When a spawn fails because the token is missing, the UI **automatically renders an inline "Connect Claude Code" card** for the failed step — one click on desktop (loopback), one paste on cloud. The card restores itself after a reload or reconnect, so it stays available. It mints and stores the OAuth token so it never enters the conversation or the workspace config.

**When a spawn fails for a missing token, do NOT prompt or instruct the user yourself.** The inline card already handles it, and the task **auto-continues** once they connect — so you don't need them to re-ask. Specifically, do NOT tell them to run `claude setup-token`, run `assistant credentials set`/`prompt`, open a terminal, or paste an `sk-ant-oat…` token — and do NOT retry the spawn yourself. Add at most one short sentence pointing at the card ("Click **Connect Claude Code** to sign in — I'll pick it back up once you're connected"), then stop and wait. Keep it terse and never say where the card is (no "above"/"below"/"at the bottom" — its placement is a UI detail you can't see): do not narrate that a card appeared, explain how the sign-in works, or say "nothing to paste" (the cloud flow does paste a key).

**Fallback (headless environments where no inline card can appear):** the user runs `claude setup-token` on a machine where they are logged in to Claude, then stores the result via the secure prompt:

```bash
assistant credentials prompt --service acp --field claude_oauth_token --label "Claude OAuth Token"
```

This is strictly for headless/channel sessions. In an interactive session the daemon **refuses** this prompt for `acp/claude_oauth_token` and returns a message pointing at the inline Connect card, so do not run it to work around the card — just wait for the user to connect.

Do NOT ask the user to paste the token into chat — the secure prompt keeps it out of the conversation and the workspace config.

## Codex setup

The `@agentclientprotocol/codex-acp` adapter runs Codex App Server using its included `@openai/codex` dependency.

**Authenticate.** The adapter reuses an existing Codex login. To sign in, use `codex login` from an installed Codex CLI. API-key authentication supports `CODEX_API_KEY` and `OPENAI_API_KEY`.

**Optional CLI override.** Set `CODEX_PATH` in the agent profile's `env` to use a different compatible Codex executable. Keep the agent command as `codex-acp`.

Do NOT put API keys (or any secret) in the workspace config file - secrets never belong in the workspace directory. Use the credential store instead.

## Critical: correct agent command

- Two agents are supported out-of-box: `claude` (via the `claude-agent-acp` adapter) and `codex` (via the `codex-acp` adapter).
- NEVER use `claude`, `claude -p`, `claude --acp`, or the bare `codex` CLI as the ACP `command`. Claude and Codex only speak the protocol through their dedicated `*-acp` adapters.
- Default profiles for both ship out-of-box. Users only need an `agents.<id>` entry in config if they want to override the defaults (e.g. point to a custom binary path or pass extra args/env). An entry that still runs the bundled adapter, whether it omits `command` or names the same binary by name or full path, inherits the `command`, `description` and `model` it leaves out, so a single-field change such as `acp.agents.claude.model` is all it takes. An entry that points the id at a different binary stands on its own, so it must spell out everything it needs, `command` included.
- NEVER change an existing ACP config to use a different command. If the config already has `claude-agent-acp` or `codex-acp`, leave it alone.

## Updating an adapter

Adapter upgrades ship with Assistant releases: the pinned version is what a missing adapter is installed at. An adapter already on PATH is never replaced, so a user who upgrades one themselves keeps that version.

Codex uses the adapter's bundled dependency by default, within the version range declared by the adapter. If `CODEX_PATH` selects a separate CLI, update that installation separately.

## When to use acp_steer vs acp_spawn

- **On a running session, `acp_steer` interrupts the in-flight prompt.** Use it to course-correct ("stop, do X instead"). It cancels whatever the agent is currently working on and replaces it with the new instruction. Queued follow-ups behind a running prompt are not supported - wait for the `acp_session_completed` notification instead.
- **On a completed (or assistant-restarted) session, `acp_steer` transparently resumes it.** The session is restored from persisted history via ACP session loading when the agent supports it, and the new instruction runs with the agent's full prior context. This is the primary way to do follow-up work on an existing session id - prefer it over spawning a fresh session that would lose context.
- If resume isn't possible (the session was recorded before resume support and has no working directory, or the agent lacks the capability), the error explains why; fall back to `acp_spawn`. For claude sessions, the completion message also includes a `claude --resume <id>` CLI hint for resuming outside the assistant.

## Discoverability

Use `acp_list_agents` to see what's set up and what's missing. It returns each available agent profile, whether the agent's binary is on PATH (missing binaries are installed automatically on first spawn), and an install hint if not. This is the right tool to call when deciding between `claude` and `codex`, or when the user asks "what coding agents do I have?"

## Working directory

Default to the conversation's current working directory when spawning an agent. For risky changes or parallel work where you don't want the agent touching the same checkout the user is editing, create a git worktree first via the shell tool and pass that worktree path as `cwd` to `acp_spawn`. That keeps the agent isolated from the user's in-progress work.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- Use `acp_status` to check on running agents and `acp_abort` to stop them.
- The `cwd` parameter controls where the agent works - set it to the project root the user wants the agent to operate in.
