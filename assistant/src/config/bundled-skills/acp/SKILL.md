---
name: acp
description: Spawn external coding agents via the Agent Communication Protocol (ACP)
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔗"
  vellum:
    display-name: "ACP"
---

ACP agent orchestration -- spawn external coding agents (Claude Code, Codex, Gemini CLI, etc.) to work on tasks.

## Usage

Use `acp_spawn` to delegate a coding task to an external agent. The agent runs as a subprocess and streams results back via SSE.

## Configuration

ACP must be enabled in the assistant config with at least one agent configured:

```yaml
acp:
  enabled: true
  agents:
    claude:
      command: claude
      args: ["-p", "..."]
```

## Tips

- The spawned agent runs autonomously with its own tools, file editing, and terminal access.
- Results are streamed back to the client via SSE events.
- You will be notified when the agent completes.
