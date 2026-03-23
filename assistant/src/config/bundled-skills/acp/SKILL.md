---
name: acp
description: Spawn external coding agents via the Agent Client Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
---

ACP agent orchestration - spawn external coding agents (Claude Code, Codex, Gemini CLI, etc.) to work on tasks via the Agent Client Protocol.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

## First-time setup

When the user first tries to use ACP and it's not configured, set it up automatically:

1. **Check if `claude-agent-acp` is installed** by running `which claude-agent-acp`. If not found, install it:
   ```bash
   npm install -g @zed-industries/claude-agent-acp
   ```

2. **Enable ACP in the workspace config** by editing the config file to add the `acp` section. The correct config is:
   ```json
   {
     "acp": {
       "enabled": true,
       "maxConcurrentSessions": 4,
       "agents": {
         "claude": {
           "command": "claude-agent-acp",
           "args": [],
           "description": "Claude Code (via ACP adapter)"
         }
       }
     }
   }
   ```

3. **Wait a few seconds** for the config watcher to pick up the change (it hot-reloads automatically - no restart needed).

4. Then retry the `acp_spawn` call. Do NOT run `vellum sleep && vellum wake` - that kills the conversation.

## Critical: correct agent command

- The command MUST be `claude-agent-acp` - this is the ACP adapter from `@zed-industries/claude-agent-acp`.
- NEVER use `claude`, `claude -p`, `claude --acp`, or any other command. Only `claude-agent-acp` speaks the ACP JSON-RPC protocol.
- NEVER change an existing ACP config to use a different command. If the config already has `claude-agent-acp`, leave it alone.

## Updating the adapter

If `acp_spawn` reports that `claude-agent-acp` is outdated, ask the user before updating. To update:

```bash
npm install -g @zed-industries/claude-agent-acp@latest
```

Then retry the `acp_spawn` call.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- Use `acp_status` to check on running agents and `acp_abort` to stop them.
- The `cwd` parameter controls where the agent works - set it to the project root the user wants the agent to operate in.
