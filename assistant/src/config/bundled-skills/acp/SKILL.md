---
name: acp
description: Spawn external coding agents via the Agent Client Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
    activation-hints:
      - "User asks to use Claude Code, Codex, or Gemini to do something"
      - "User wants to delegate a coding task to Claude Code, Codex, Gemini, or another ACP agent"
      - "User wants to hand a coding task to another agent and check on it later"
      - "User wants to spawn an external coding agent that runs autonomously and streams results back"
      - "User mentions ACP, claude-agent-acp, codex-acp, gemini --acp, or running multiple coding agents in parallel"
    avoid-when:
      - "Task is small enough to do inline with the assistant's own tools - no need for an external agent"
---

ACP agent orchestration - spawn external coding agents (Claude Code, Codex, Gemini) to work on tasks via the Agent Client Protocol. Each agent runs as its own subprocess speaking ACP over stdio and streams results back into the conversation.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

Users can refer to agents by natural names: "claude code", "codex cli", "openai codex", "gemini cli", and "google gemini" all resolve to the canonical `claude`, `codex`, and `gemini` ids (unless the user's config defines an agent literally keyed by that name, which always wins).

## First-time setup

When the user first tries to use ACP and it's not enabled, set it up automatically:

1. **Enable the `acp` feature flag** (the primary enablement path). Either PATCH it via the gateway feature-flags endpoint or direct the user to toggle "ACP Coding Agents" in the client's feature flags UI. Flag changes are hot-refreshed in the assistant - no restart needed.

   As a supported alternative, edit the workspace config file to add the `acp` section. Default profiles for `claude`, `codex`, and `gemini` ship out-of-box, so the minimal config is just:
   ```json
   {
     "acp": {
       "enabled": true,
       "maxConcurrentSessions": 4
     }
   }
   ```
   If you go the config route, **wait a few seconds** for the config watcher to pick up the change (it hot-reloads automatically - no restart needed).

2. Then retry the `acp_spawn` call. Do NOT run `vellum sleep && vellum wake` - that kills the conversation.

No manual binary installation is needed first: missing adapter binaries are installed automatically (see below).

## Automatic adapter installation

When `acp_spawn` finds the agent's binary missing from PATH, the assistant silently installs the matching npm package globally and proceeds in the same call. Only the allowlisted out-of-box packages are ever auto-installed (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`, `@google/gemini-cli`); user-configured agents with custom commands are never installed automatically.

Manual installation is fallback guidance for unusual setups: npm unavailable, restricted global installs, or an auto-install failure (the failure reason is surfaced in the tool result).

```bash
npm i -g @agentclientprotocol/claude-agent-acp   # claude
npm i -g @zed-industries/codex-acp               # codex
npm i -g @google/gemini-cli                      # gemini
```

## Codex setup

The `codex-acp` adapter is auto-installed, but it shells out to the underlying `codex` CLI, which must also be on PATH:

1. **Install the Codex CLI** (version 0.111 or higher) via OpenAI's distribution channel of choice. The adapter will fail if `codex` isn't on PATH.

2. **Authenticate.** The `codex-acp` adapter inherits whatever auth the underlying `codex` CLI uses. Typical flows:
   - `codex login` (OAuth)
   - `CODEX_API_KEY` environment variable
   - `OPENAI_API_KEY` environment variable

## Gemini setup

Gemini CLI speaks ACP natively (`gemini --acp`) - there is no separate adapter binary. The CLI itself is auto-installed from `@google/gemini-cli` when missing.

**Authenticate** via either:
- Browser OAuth: run `gemini` once interactively and complete the sign-in flow.
- `GEMINI_API_KEY` environment variable. To pass it to spawned sessions, set it under `acp.agents.gemini.env` in the workspace config.

## Critical: correct agent command

- Three agents are supported out-of-box: `claude` (via the `claude-agent-acp` adapter), `codex` (via the `codex-acp` adapter), and `gemini` (via `gemini --acp` - Gemini speaks ACP natively, no adapter binary).
- NEVER use `claude`, `claude -p`, `claude --acp`, or the bare `codex` CLI as the ACP `command`. Claude and Codex only speak the protocol through their dedicated `*-acp` adapters. Gemini is the exception: the `gemini` CLI itself speaks ACP when launched with `--acp`.
- Default profiles for all three ship out-of-box. Users only need an `agents.<id>` entry in config if they want to override the defaults (e.g. point to a custom binary path or pass extra args/env).
- NEVER change an existing ACP config to use a different command. If the config already has `claude-agent-acp`, `codex-acp`, or `gemini`, leave it alone.

## Updating an adapter

If `acp_spawn` reports that an adapter is outdated, ask the user before updating. To update:

```bash
npm i -g @agentclientprotocol/claude-agent-acp@latest
# or
npm i -g @zed-industries/codex-acp@latest
# or
npm i -g @google/gemini-cli@latest
```

Then retry the `acp_spawn` call.

## When to use acp_steer vs acp_spawn

- **On a running session, `acp_steer` interrupts the in-flight prompt.** Use it to course-correct ("stop, do X instead"). It cancels whatever the agent is currently working on and replaces it with the new instruction. Queued follow-ups behind a running prompt are not supported - wait for the `acp_session_completed` notification instead.
- **On a completed (or assistant-restarted) session, `acp_steer` transparently resumes it.** The session is restored from persisted history via ACP session loading when the agent supports it, and the new instruction runs with the agent's full prior context. This is the primary way to do follow-up work on an existing session id - prefer it over spawning a fresh session that would lose context.
- If resume isn't possible (the session was recorded before resume support and has no working directory, or the agent lacks the capability), the error explains why; fall back to `acp_spawn`. For claude sessions, the completion message also includes a `claude --resume <id>` CLI hint for resuming outside the assistant.

## Discoverability

Use `acp_list_agents` to see what's set up and what's missing. It returns each available agent profile, whether ACP is enabled, whether the agent's binary is on PATH, and an install hint if not. This is the right tool to call when deciding between `claude`, `codex`, and `gemini`, or when the user asks "what coding agents do I have?"

## Working directory

Default to the conversation's current working directory when spawning an agent. For risky changes or parallel work where you don't want the agent touching the same checkout the user is editing, create a git worktree first via the shell tool and pass that worktree path as `cwd` to `acp_spawn`. That keeps the agent isolated from the user's in-progress work.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- Use `acp_status` to check on running agents and `acp_abort` to stop them.
- The `cwd` parameter controls where the agent works - set it to the project root the user wants the agent to operate in.
