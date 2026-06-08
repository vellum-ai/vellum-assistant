---
name: mcp-setup
description: Add, authenticate, list, and remove MCP (Model Context Protocol) servers — connect any external tool or service to the assistant. Works with Figma, Linear, GitHub, Notion, Slack, Jira, Sentry, Stripe, Postgres, Google Drive, Vercel, GitLab, Cloudflare, Brave Search, and any other service that publishes an MCP endpoint
compatibility: "Requires the Vellum desktop app (local daemon). Does not work with platform-hosted assistants."
metadata:
  emoji: "🔌"
  vellum:
    category: "integrations"
    display-name: "MCP Setup"
---

Configure MCP servers to give the assistant access to any external tool or service that publishes an MCP endpoint.

**DO NOT** run exploratory commands. Do not check available CLI commands, look up documentation, search for bun/npx/node, or investigate transport types. Follow the steps below exactly and stop when done.

## When to Use

USE THIS SKILL WHEN:

- User asks to connect any external tool or service via MCP
- User asks "what MCP servers / integrations do I have?"
- An MCP tool returns an auth error → run `assistant mcp auth <name>`
- User wants to disconnect an integration

## Step 1 — Verify you are on the desktop app (HARD GATE)

⚠️ **This is a hard gate. Do not run any `assistant mcp` command until it passes.**

MCP servers only work on the local desktop daemon. A cloud / platform-hosted
session **has `bash`**, so `mcp add` and `mcp list` will appear to succeed — but
the config is written to the cloud daemon, not the user's machine, and the
`auth` step can never complete because there is no browser on the host. The
result is a zombie config: half set up, impossible to authenticate. **`bash`
succeeding proves nothing. Only `host_bash` confirms you are on the machine that
can finish the flow.**

**Before doing anything else**, run this via `host_bash` (not `bash`):

```
echo "desktop ok"
```

- If it succeeds → you are on the desktop. Proceed.
- If `host_bash` is unavailable, denied, or you only have `bash` → **STOP NOW.**
  Do not run `mcp add`. Do not run `mcp list`. Tell the user:

> This skill needs the **Vellum desktop app** — MCP setup can't run from a
> cloud session because the OAuth step needs a browser on your machine. Please
> open the desktop app from [vellum.ai](https://vellum.ai) and ask me there.

Writing an MCP config from a cloud session creates a broken server the user
cannot authenticate. Refuse to start rather than leave a half-configured mess.

## Step 2 — Check the recipe table

**Check this table before doing anything else.** If the service is listed, run the command shown and do nothing else — no exploration, no checking available commands, no looking up documentation.

| Service | Command | After? |
|---------|---------|--------|
| Context7 (docs) | `assistant mcp add context7 -t streamable-http -u https://mcp.context7.com/mcp -r low` | Done — no auth needed |
| Linear | `assistant mcp add linear -t streamable-http -u https://mcp.linear.app/mcp` | Run `assistant mcp auth linear` |
| Figma | `assistant mcp add figma -t streamable-http -u https://mcp.figma.com/mcp` | Run `assistant mcp auth figma` |

If the service is not in this table, go to Step 3.

## Step 3 — Unknown service

Find the MCP endpoint URL in the service's documentation, then run:

```
assistant mcp add <name> -t streamable-http -u <url>
```

Then run `assistant mcp list`. If it shows `! Needs authentication`, run `assistant mcp auth <name>` via `host_bash`.

---

## Reference: All Commands

Run `list`, `add`, `remove`, and `reload` via the `bash` tool. Run `auth` via `host_bash` (it opens a browser).

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

Run via `host_bash`. Opens the user's browser for OAuth login. Tokens are saved automatically. Use when:
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

`mcp add` covers the common cases. For advanced options, edit `~/.vellum/workspace/config.json` directly under `mcp.servers.<name>`:

- `env` — environment variables for stdio servers
- `headers` — custom HTTP headers for remote servers
- `maxTools` — per-server tool cap (default: 20)
- `allowedTools` / `blockedTools` — tool name filters
- `globalMaxTools` — total cap across all servers (default: 50)

## SKILL COMPLETE WHEN

The MCP server appears in `assistant mcp list` with status `✓ Connected` and the user confirms tools from that server are available in the conversation.
