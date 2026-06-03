---
name: acp
description: Spawn external coding agents via the Agent Client Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
    activation-hints:
      - "User wants to delegate a coding task to Claude Code, Codex, or another ACP agent"
      - "User wants to spawn an external coding agent that runs autonomously and streams results back"
      - "User mentions ACP, claude-agent-acp, codex-acp, or running multiple coding agents in parallel"
    avoid-when:
      - "Task is small enough to do inline with the assistant's own tools — no need for an external agent"
---

ACP agent orchestration - spawn external coding agents (Claude Code, Codex, etc.) to work on tasks via the Agent Client Protocol. Each agent runs as its own subprocess speaking ACP over stdio and streams results back into the conversation.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

## First-time setup

When the user first tries to use ACP and it's not configured, set it up automatically:

1. **Check if `claude-agent-acp` is installed** by running `which claude-agent-acp`. If not found, install it:
   ```bash
   npm i -g @agentclientprotocol/claude-agent-acp
   ```

2. **Enable ACP in the workspace config** by editing the config file to add the `acp` section. Default profiles for `claude` and `codex` ship out-of-box, so the minimal config is just:
   ```json
   {
     "acp": {
       "enabled": true,
       "maxConcurrentSessions": 4
     }
   }
   ```

3. **Wait a few seconds** for the config watcher to pick up the change (it hot-reloads automatically - no restart needed).

4. Then retry the `acp_spawn` call. Do NOT run `vellum sleep && vellum wake` - that kills the conversation.

## Codex setup

To use Codex via ACP, both the `codex-acp` adapter and the underlying `codex` CLI must be on PATH:

1. **Install the ACP adapter:**
   ```bash
   npm i -g @zed-industries/codex-acp
   ```
   This provides the `codex-acp` binary that the assistant spawns.

2. **Install the Codex CLI** (version 0.111 or higher) via OpenAI's distribution channel of choice. The `codex-acp` adapter shells out to `codex` under the hood and will fail if it isn't on PATH.

3. **Authenticate.** The `codex-acp` adapter inherits whatever auth the underlying `codex` CLI uses. Typical flows:
   - `codex login` (OAuth)
   - `CODEX_API_KEY` environment variable
   - `OPENAI_API_KEY` environment variable

If `codex-acp` isn't on PATH when the user asks for it, the assistant will surface the install hint via `acp_list_agents`.

## Critical: correct agent command

- `claude-agent-acp` and `codex-acp` are the two supported adapter binaries today. They are what speak the ACP JSON-RPC protocol.
- NEVER use `claude`, `claude -p`, `claude --acp`, the bare `codex` CLI, or any other command as the ACP `command`. Only the dedicated `*-acp` adapters speak the protocol.
- Default profiles for `claude` and `codex` ship out-of-box. Users only need an `agents.<id>` entry in config if they want to override the defaults (e.g. point to a custom binary path or pass extra args).
- NEVER change an existing ACP config to use a different command. If the config already has `claude-agent-acp` or `codex-acp`, leave it alone.

## Updating the adapter

If `acp_spawn` reports that an adapter is outdated, ask the user before updating. To update:

```bash
npm i -g @agentclientprotocol/claude-agent-acp@latest
# or
npm i -g @zed-industries/codex-acp@latest
```

Then retry the `acp_spawn` call.

## When to use acp_continue vs acp_spawn vs acp_steer

Three distinct verbs — pick by intent:

- **`acp_continue` builds on the SAME session.** This is the default for iterating on the same piece of work. After a session reports `acp_session_completed`, call `acp_continue` with the follow-up ("now also do Y", "fix the test you just broke", "address the review comments"). The agent reuses its existing process, ACP session, context, and workspace, so it remembers what it just did. By default it targets the conversation's most-recent live session; pass an explicit `acp_session_id` to continue a specific one.
- **`acp_spawn` starts a FRESH session.** Use it only when you want a brand-new agent with no prior context — a different, unrelated task, or parallel work in a separate workspace/worktree.
- **`acp_steer` interrupts the in-flight prompt.** Use it to course-correct a *running* agent mid-task ("stop, do X instead"). It cancels whatever the agent is currently working on and replaces it with the new instruction.

Rule of thumb: same thread of work → `acp_continue`; new unrelated work → `acp_spawn`; redirect something already running → `acp_steer`. Do NOT wait-for-completion-then-respawn to continue work — that loses the agent's context; use `acp_continue` instead.

## Discoverability

Use `acp_list_agents` to see what's set up and what's missing. It returns each available agent profile, whether ACP is enabled, whether the agent's binary is on PATH, and an install hint if not. This is the right tool to call when deciding between `claude` and `codex`, or when the user asks "what coding agents do I have?"

## Working directory

When you omit `cwd`, the agent defaults to a **stable per-project workspace** under the persistent workspace volume, keyed by the conversation. This directory survives across turns, agent respawns, and idle-sleep/wake, so repos the agent clones and files it edits are still there on the next `acp_spawn` for the same conversation. Prefer this default for ongoing work — don't pass an ephemeral temp dir, which would be lost on respawn.

For risky changes or parallel work where you don't want the agent touching the same checkout, create a git worktree first via the shell tool (inside the persistent workspace) and pass that worktree path as `cwd` to `acp_spawn`. That keeps the agent isolated from other in-progress work while still persisting.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- Use `acp_status` to check on running agents and `acp_abort` to stop them.
- The `cwd` parameter controls where the agent works - set it to the project root the user wants the agent to operate in.
