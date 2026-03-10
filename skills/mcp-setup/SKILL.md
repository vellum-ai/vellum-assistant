---
name: mcp-setup
description: Add, authenticate, list, and remove MCP (Model Context Protocol) servers
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "🔌"
  vellum:
    display-name: "MCP Setup"
    user-invocable: false
---

Help users configure MCP servers so external tools (e.g. Linear, GitHub, Notion) become available in conversations.

## CLI Commands

All commands use `assistant mcp`. Run them via `host_bash`.

### List servers

```
assistant mcp list
```

Shows all configured servers with connection status, transport type, and URL.

### Add a server

```
assistant mcp add <name> -t <transport-type> -u <url> [-r <risk>] [--disabled]
```

- `<name>` — unique identifier (e.g. `linear`, `github`)
- `-t` — transport type: `stdio`, `sse`, or `streamable-http`
- `-u` — server URL (required for `sse`/`streamable-http`)
- `-c` — command (required for `stdio`), `-a` for args
- `-r` — risk level: `low`, `medium`, or `high` (default: `high`)

Examples:

```
assistant mcp add linear -t streamable-http -u https://mcp.linear.app/mcp
assistant mcp add context7 -t streamable-http -u https://mcp.context7.com/mcp -r low
assistant mcp add local-db -t stdio -c npx -a -y @my/mcp-server
```

### Authenticate (OAuth)

```
assistant mcp auth <name>
```

Opens the user's browser for OAuth authorization. Only works for `sse`/`streamable-http` servers that require authentication. After the user completes login in the browser, tokens are saved automatically.

Use this when:

- A server shows `! Needs authentication` in `assistant mcp list`
- An MCP tool call fails with an auth/token error
- Setting up a new OAuth-protected server for the first time

### Remove a server

```
assistant mcp remove <name>
```

Removes the server config and cleans up any stored OAuth credentials.

## After Changes

After adding, removing, or authenticating a server, the user must **quit and relaunch the Vellum app** for changes to take effect. The app runs its own assistant process — `assistant daemon restart` only restarts the CLI assistant, which is a separate process.

Tell the user: "Please quit and relaunch the Vellum app, then start a new conversation."

## When to Use

- User asks to connect/set up an external service via MCP
- User asks "what MCP servers do I have?"
- An MCP tool returns an auth error — offer to run `assistant mcp auth <name>`
- User wants to remove an MCP integration
