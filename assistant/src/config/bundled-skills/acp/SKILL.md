---
name: acp
description: Spawn external coding agents via the Agent Client Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
    category: "development"
    activation-hints:
      - "User asks to use Claude Code or Codex to do something"
      - "User wants to delegate a coding task to Claude Code, Codex, or another ACP agent"
      - "User wants to hand a coding task to another agent and check on it later"
      - "User wants to spawn an external coding agent that runs autonomously and streams results back"
      - "User mentions ACP, claude-agent-acp, codex-acp, or running multiple coding agents in parallel"
    avoid-when:
      - "Task is small enough to do inline with the assistant's own tools - no need for an external agent"
---

ACP agent orchestration - spawn external coding agents (Claude Code, Codex) to work on tasks via the Agent Client Protocol. Each agent runs as its own subprocess speaking ACP over stdio and streams results back into the conversation.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

Users can refer to agents by natural names: "claude code", "codex cli", and "openai codex" all resolve to the canonical `claude` and `codex` ids (unless the user's config defines an agent literally keyed by that name, which always wins).

## First-time setup

ACP is always available - default profiles for `claude` and `codex` ship out-of-box, so no config edit is needed to start. First-time setup is just making the adapter binary available, then spawning:

1. Install the adapter binary if it's missing. This happens automatically: when `acp_spawn` finds the agent's binary missing from PATH, the assistant installs it once via a sandboxed bun global install and proceeds in the same call (see "Automatic adapter availability" below).

2. Call `acp_spawn`. Do NOT run `vellum sleep && vellum wake` - that kills the conversation.

## Automatic adapter availability

When `acp_spawn` finds the agent's binary missing from PATH, the assistant installs it once via a sandboxed bun global install and then runs the real installed binary. The install runs in a fresh empty temporary directory (never the task's project directory), with known secrets stripped from the installer environment and the registry pinned to the public npm registry, so a malicious project directory cannot hijack package resolution or capture a token. After this one-time install, the adapter is a normal trusted binary on PATH and every later spawn (and resume) uses it directly.

Only the allowlisted out-of-box packages are ever installed this way (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`); user-configured agents with custom commands are never installed automatically.

Manual installation is fallback guidance for unusual setups: bun unavailable, restricted global installs, or an auto-install failure (the failure reason is surfaced in the tool result).

```bash
bun add -g @agentclientprotocol/claude-agent-acp   # claude
bun add -g @zed-industries/codex-acp               # codex
```

## Claude setup

The `claude-agent-acp` adapter requires a Claude **OAuth token** (`sk-ant-oat…`), NOT an API key (`sk-ant-api…`). Every spawn injects the stored token as `CLAUDE_CODE_OAUTH_TOKEN` automatically. The write path rejects an API key in this field, so never direct a user to paste an `sk-ant-api…` key here.

**Primary: the in-app Connect Claude Code flow.** When a spawn fails because the token is missing, the UI **automatically renders an inline "Connect Claude Code" card** directly below the failed step — one click on desktop (loopback), one paste on cloud. It mints and stores the OAuth token so it never enters the conversation or the workspace config.

**When a spawn fails for a missing token, do NOT prompt the user yourself.** The inline card already handles it, so do not emit an options question, a "connect via Settings vs paste a token" choice, or CLI instructions — a second prompt on top of the card is redundant and confusing. At most, add one short sentence pointing at it ("Click **Connect Claude Code** above to sign in, then ask me again"), then stop and wait for the user to connect.

**Fallback (headless environments where no inline card can appear):** the user runs `claude setup-token` on a machine where they are logged in to Claude, then stores the result via the secure prompt:

```bash
assistant credentials prompt --service acp --field claude_oauth_token --label "Claude OAuth Token"
```

Do NOT ask the user to paste the token into chat — the secure prompt keeps it out of the conversation and the workspace config.

## Codex setup

The `codex-acp` adapter is installed automatically when missing, but it shells out to the underlying `codex` CLI, which must also be on PATH:

1. **Install the Codex CLI** (version 0.111 or higher) via OpenAI's distribution channel of choice. The adapter will fail if `codex` isn't on PATH.

2. **Authenticate.** The `codex-acp` adapter inherits whatever auth the underlying `codex` CLI uses. Typical flows:
   - `codex login` (OAuth)
   - `CODEX_API_KEY` environment variable
   - `OPENAI_API_KEY` environment variable

Do NOT put API keys (or any secret) in the workspace config file - secrets never belong in the workspace directory. Use the credential store instead.

## Critical: correct agent command

- Two agents are supported out-of-box: `claude` (via the `claude-agent-acp` adapter) and `codex` (via the `codex-acp` adapter).
- NEVER use `claude`, `claude -p`, `claude --acp`, or the bare `codex` CLI as the ACP `command`. Claude and Codex only speak the protocol through their dedicated `*-acp` adapters.
- Default profiles for both ship out-of-box. Users only need an `agents.<id>` entry in config if they want to override the defaults (e.g. point to a custom binary path or pass extra args/env). An `acp.agents.<id>` entry replaces the bundled default entirely (no field merge), so any override must spell out the full `command` and `args`, not just the field being changed.
- NEVER change an existing ACP config to use a different command. If the config already has `claude-agent-acp` or `codex-acp`, leave it alone.

## Updating an adapter

Adapters are installed once via a bun global install. To update one to the latest version, ask the user first, then re-install it globally:

```bash
bun add -g @agentclientprotocol/claude-agent-acp@latest
# or
bun add -g @zed-industries/codex-acp@latest
```

Then retry the `acp_spawn` call.

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
