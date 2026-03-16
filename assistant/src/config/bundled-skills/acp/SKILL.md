---
name: acp
description: Spawn external coding agents via the Agent Client Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
---

ACP agent orchestration — spawn external coding agents (Claude Code, Codex, Gemini CLI, etc.) to work on tasks via the Agent Client Protocol.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess speaking the ACP protocol over stdio and streams results back.

## Configuration

ACP must be enabled in the workspace config with at least one agent configured. **Do NOT modify the ACP config** — it is pre-configured by the user.

The correct config uses `claude-agent-acp` (the ACP adapter), NOT `claude -p`:

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

**Important:**
- `claude-agent-acp` is a standalone ACP adapter from `@zed-industries/claude-agent-acp` that speaks the ACP JSON-RPC protocol over stdio.
- Do NOT change the command to `claude`, `claude -p`, or anything else. The ACP protocol requires a specific adapter.
- Do NOT edit the user's ACP config. If ACP is not enabled or the agent is not found, report the error and let the user fix it.

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back and injected into the conversation when the agent completes.
- The completion message includes a session ID that can be used with `claude --resume <sessionId>`.
- Use `acp_status` to check on running agents and `acp_abort` to stop them.
