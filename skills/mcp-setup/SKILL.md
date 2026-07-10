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
- An MCP tool returns an auth error → start OAuth with `assistant mcp auth <name> --no-wait` and relay the URL (see "Authenticate (OAuth)")
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

| Service         | Command                                                                                | After?                                          |
| --------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Context7 (docs) | `assistant mcp add context7 -t streamable-http -u https://mcp.context7.com/mcp -r low` | Done — `add` reports `connected`, no auth needed |
| Linear          | `assistant mcp add linear -t streamable-http -u https://mcp.linear.app/mcp`            | `add` reports `needs-auth` → do the OAuth flow  |
| Figma           | `assistant mcp add figma -t streamable-http -u https://mcp.figma.com/mcp`              | `add` reports `needs-auth` → do the OAuth flow  |

`assistant mcp add` verifies the connection and prints one of `connected`,
`needs-auth`, or an error. When it reports `needs-auth`, follow the
non-blocking OAuth flow in "Authenticate (OAuth)" below — never run a blocking
`assistant mcp auth` from your shell tool.

If the service is not in this table, go to Step 3.

## Step 3 — Unknown service

Find the MCP endpoint URL in the service's documentation, then decide how the
server authenticates:

- **OAuth** (login in a browser) → add it, then follow the OAuth flow:

  ```
  assistant mcp add <name> -t streamable-http -u <url>
  ```

  `add` verifies and prints the status. If it reports `needs-auth`, do the
  non-blocking OAuth flow in "Authenticate (OAuth)" below.

- **API key / bearer token** (the service gives you a static key) → collect the
  key through the secure prompt, then reference it — the key never touches the
  shell or the conversation:

  ```
  assistant credentials prompt --service <name> --field api_key --label "<Service> API key"
  assistant mcp add <name> -t streamable-http -u <url> --auth-credential <name>/api_key
  ```

  See "Add a server" for `--auth-header` / `--auth-prefix` when the service
  uses a custom header instead of `Authorization: Bearer`.

---

## Reference: All Commands

Run all `mcp` commands — `list`, `add`, `remove`, `reload`, and `auth` — via `bash` on both environments. The non-blocking OAuth flow (below) relays the authorization URL to the user, so no local browser tool is needed.

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
assistant mcp add <name> -t <transport> -u <url> [-r low|medium|high] [--disabled] [--no-verify]
```

Transport types:

- `streamable-http` — most modern remote servers (use this by default)
- `sse` — legacy remote servers
- `stdio` — local process: use `-c <command>` and `-a <args...>` instead of `-u`

Risk level (`-r`) controls approval prompts per tool call — `low` auto-approves, `high` always prompts (default: `high`).

After writing the config, `add` verifies the server with a bounded connection
and prints `connected`, `needs-auth` (do the OAuth flow), or an error. Pass
`--no-verify` to skip the check and return immediately.

Examples:

```
assistant mcp add linear -t streamable-http -u https://mcp.linear.app/mcp
assistant mcp add context7 -t streamable-http -u https://mcp.context7.com/mcp -r low
assistant mcp add local-db -t stdio -c npx -a -y @my/mcp-server
```

#### API-key / bearer auth (recommended for static keys)

For servers that authenticate with a static API key or bearer token, store the
secret in the encrypted vault first, then reference it with
`--auth-credential <service>/<field>`. The key is resolved on connect (and on
reconnect, so rotations are picked up) and **never** passes through the shell or
the conversation:

```
assistant credentials prompt --service reducto --field api_key --label "Reducto API key"
assistant mcp add reducto -t streamable-http -u https://mcp.reducto.ai/mcp \
    --auth-credential reducto/api_key
```

`--auth-header` defaults to `Authorization` and `--auth-prefix` defaults to
`"Bearer "`. For a custom API-key header, set both — e.g. a server that expects
`X-API-Key: <key>` with no prefix:

```
assistant mcp add acme -t streamable-http -u https://mcp.acme.com/mcp \
    --auth-credential acme/api_key --auth-header X-API-Key --auth-prefix ''
```

**Never** do these — they silently produce a broken, unauthenticated server:

- Never put a secret in a `${ENV_VAR}` shell expansion in `-H`/`--header`. The
  assistant strips environment variables before running, so the header is
  stored empty (and `add` rejects `${...}` and empty header values).
- Never `assistant credentials reveal` a secret into an `mcp add` command line.
  That leaks the plaintext into the conversation and command history — use
  `--auth-credential` so the value stays in the vault.

To inject a stored credential from a raw `-H`/`--header`, use the placeholder
syntax instead of a shell variable:

```
assistant mcp add srv -t streamable-http -u https://srv.example.com/mcp \
    -H 'Authorization: Bearer {{credential:srv/api_key}}'
```

### Authenticate (OAuth)

Use the **non-blocking** flow. A plain `assistant mcp auth <name>` blocks for up
to 2.5 minutes waiting for the browser login — running that from your shell tool
wedges the whole conversation turn. Instead:

1. Start the flow and print the authorization URL without waiting:

   ```
   assistant mcp auth <name> --no-wait
   ```

2. Relay the printed authorization URL to the user as a clickable link and ask
   them to complete the login in their browser.

3. Poll for completion (do not block):

   ```
   assistant mcp auth <name> --status
   ```

   Repeat every few seconds until it reports the flow is complete, or check
   `assistant mcp list` for `✓ Connected`. Once complete, the running assistant
   picks up the change automatically.

Once authenticated, tokens are cached and **refresh automatically** — the user
does not need to re-auth on expiry. If a server's client registration goes stale
or the token flow breaks, force a fresh registration with:

```
assistant mcp auth <name> --reset
```

Use the OAuth flow when:

- `assistant mcp add` or `assistant mcp list` reports `needs-auth`
- An MCP tool call fails with an auth/token error
- Setting up a new OAuth-protected server for the first time

Run these via `bash` on both environments — the running assistant handles the
browser redirect and token exchange.

### Remove a server

```
assistant mcp remove <name>
```

Removes config and cleans up stored OAuth credentials.

### Reload

```
assistant mcp reload           # fire-and-forget
assistant mcp reload --wait     # block and print each server's connection status
```

Signals the assistant to reconnect all MCP servers from disk. Normally not needed — the assistant detects changes automatically after `add`, `remove`, and `auth`. Use `--wait` to confirm a server reconnected (it prints `connected` / `needs-auth` / `disabled` / `error` per server) instead of adding a sleep and re-running `assistant mcp list`.

## Advanced Configuration

`mcp add` covers the common cases, including auth headers via `--auth-credential`
(see "Add a server"). For remaining advanced options, edit
`$VELLUM_WORKSPACE_DIR/config.json` directly under `mcp.servers.<name>`:

- `env` — environment variables for stdio servers
- `maxTools` — per-server tool cap (default: 20)
- `allowedTools` / `blockedTools` — tool name filters
- `globalMaxTools` — total cap across all servers (default: 50)

Do **not** hand-edit auth headers into `mcp.servers.<name>`. Use
`--auth-credential` (or the `{{credential:service/field}}` placeholder in
`-H`/`--header`) so the secret is stored in the encrypted vault and resolved on
connect — config-level header secrets are not the supported path.

## SKILL COMPLETE WHEN

Match the completion condition to the task:

- **Add / authenticate:** the server appears in `assistant mcp list` with status `✓ Connected` and the user confirms its tools are available in the conversation.
- **List:** the current servers (or the fact that none are configured) have been reported to the user.
- **Remove / disconnect:** `assistant mcp remove <name>` succeeds and the server no longer appears in `assistant mcp list`.
