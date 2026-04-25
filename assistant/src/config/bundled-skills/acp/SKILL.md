---
name: acp
description: Spawn external coding agents via the Agent Client Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
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

## When to use acp_steer vs acp_spawn

- **`acp_steer` interrupts the in-flight prompt.** Use it to course-correct a running agent ("stop, do X instead"). It cancels whatever the agent is currently working on and replaces it with the new instruction.
- **For follow-ups after the current task** ("also do Y when you're done"), do NOT use `acp_steer`. Wait for the `acp_session_completed` notification and call `acp_spawn` again with the new task. Queued follow-ups in the same session are not yet supported.

## Discoverability

Use `acp_list_agents` to see what's set up and what's missing. It returns each available agent profile, whether ACP is enabled, whether the agent's binary is on PATH, and an install hint if not. This is the right tool to call when deciding between `claude` and `codex`, or when the user asks "what coding agents do I have?"

## Working directory

Default to the conversation's current working directory when spawning an agent. For risky changes or parallel work where you don't want the agent touching the same checkout the user is editing, create a git worktree first via the shell tool and pass that worktree path as `cwd` to `acp_spawn`. That keeps the agent isolated from the user's in-progress work.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- Use `acp_status` to check on running agents and `acp_abort` to stop them.
- The `cwd` parameter controls where the agent works - set it to the project root the user wants the agent to operate in.
