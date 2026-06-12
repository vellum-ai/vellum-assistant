---
name: mcp-setup
description: Add, authenticate, list, and remove MCP (Model Context Protocol) servers — connect any external tool or service that publishes an MCP endpoint to the assistant
compatibility: "Works on both the Vellum desktop app (local daemon) and the Vellum web app (platform-hosted). Auth flow differs by environment."
metadata:
  emoji: "🔌"
  vellum:
    category: "integrations"
    display-name: "MCP Setup"
---

Configure MCP servers to give the assistant access to any external tool or service that publishes an MCP endpoint.

**DO NOT** run exploratory commands. Do not check available CLI commands, search for bun/npx/node, or investigate transport types. Follow the steps below exactly and stop when done. (Looking up a service's MCP endpoint URL in its own documentation is allowed when the service is not in the recipe table, per Step 3.)

## When to Use

USE THIS SKILL WHEN:

- User asks to connect any external tool or service via MCP
- User asks "what MCP servers / integrations do I have?"
- An MCP tool returns an auth error → run `assistant mcp auth <name>`
- User wants to disconnect an integration

## Prefer Native OAuth Integration (check this first)

Many services have built-in OAuth integrations that are simpler and more reliable than MCP. Before setting up MCP, check whether the service already has a native OAuth provider:

```
assistant oauth providers list
```

If the service appears in that list, connect it natively instead of using MCP:

```
assistant oauth connect <provider>
```

**Only use MCP when:**

- The service is not in `assistant oauth providers list`
- The user explicitly asks to use MCP for a specific service
- The native OAuth integration fails or lacks features the user needs

## Step 1 — Detect your environment

**Before doing anything else**, determine which environment you are in.

Try `host_bash`:

```
echo "desktop ok"
```

- If it succeeds → you are on the **desktop app**. Use `host_bash` for all commands, including `auth` (opens a local browser).
- If it is unavailable → you are on the **web app** (or a cloud-hosted session). Use `bash` for all commands, including `auth` (the platform handles the browser redirect).

Both environments fully support MCP. The only difference is which tool runs the commands.

## Step 2 — Check the recipe table

**Check this table before doing anything else.** If the service is listed, run the command shown and do nothing else — no exploration, no checking available commands, no looking up documentation.

| Service         | Command                                                                                | After?                          |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------- |
| Context7 (docs) | `assistant mcp add context7 -t streamable-http -u https://mcp.context7.com/mcp -r low` | Done — no auth needed           |
| Linear          | `assistant mcp add linear -t streamable-http -u https://mcp.linear.app/mcp`            | Run `assistant mcp auth linear` |
| Figma           | `assistant mcp add figma -t streamable-http -u https://mcp.figma.com/mcp`              | Run `assistant mcp auth figma`  |

If the service is not in this table, go to Step 3.

## Step 3 — Unknown service

Find the MCP endpoint URL in the service's documentation, then run:

```
assistant mcp add <name> -t streamable-http -u <url>
```

Then run `assistant mcp list`. If it shows `! Needs authentication`, run `assistant mcp auth <name>`.

- On **desktop** → run via `host_bash` (opens the local browser).
- On **web app** → run via `bash` (the platform handles the browser redirect).

---

## Reference: All Commands

Run `list`, `add`, `remove`, and `reload` via `bash` on both environments. Run `auth` via `host_bash` on desktop, or via `bash` on the web app.

### List servers

```
assistant mcp list
assistant mcp list --json   # machine-readable output
```

Shows each server's connection status, transport, URL/command, and risk level. Status indicators:

- `✓` Connected
- `✗` Error or disabled
- `!` Needs authentication

### Add a server

```
assistant mcp add <name> -t <transport> -u <url> [-r low|medium|high] [--disabled]
```

Transport types:

- `streamable-http` — most modern remote servers (use this by default)
- `sse` — legacy remote servers
- `stdio` — local process: use `-c <command>` and `-a <args...>` instead of `-u`

Risk level (`-r`) controls approval prompts per tool call — `low` auto-approves, `high` always prompts (default: `high`).

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

- On **desktop** → run via `host_bash` (opens the user's local browser for OAuth login).
- On **web app** → run via `bash` (the platform handles the browser redirect and saves tokens).

Tokens are saved automatically. Use when:

- `assistant mcp list` shows `! Needs authentication`
- An MCP tool call fails with an auth/token error
- Setting up a new OAuth-protected server for the first time

### Remove a server

```
assistant mcp remove <name>
```

Removes config and cleans up stored OAuth credentials.

### Reload

```
assistant mcp reload
```

Manually signals the assistant to reconnect all MCP servers from disk. Normally not needed — the assistant detects changes automatically after `add`, `remove`, and `auth`. Use this only if a server's tools aren't appearing after ~10 seconds.

## Advanced Configuration

`mcp add` covers the common cases. For advanced options, edit `$VELLUM_WORKSPACE_DIR/config.json` directly under `mcp.servers.<name>`:

- `env` — environment variables for stdio servers
- `headers` — custom HTTP headers for remote servers
- `maxTools` — per-server tool cap (default: 20)
- `allowedTools` / `blockedTools` — tool name filters
- `globalMaxTools` — total cap across all servers (default: 50)

## SKILL COMPLETE WHEN

Match the completion condition to the task:

- **Add / authenticate:** the server appears in `assistant mcp list` with status `✓ Connected` and the user confirms its tools are available in the conversation.
- **List:** the current servers (or the fact that none are configured) have been reported to the user.
- **Remove / disconnect:** `assistant mcp remove <name>` succeeds and the server no longer appears in `assistant mcp list`.
