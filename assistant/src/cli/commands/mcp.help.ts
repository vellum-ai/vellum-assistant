/** Declarative help for the `assistant mcp` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const mcpHelp: CliCommandHelp = {
  name: "mcp",
  description: "Manage MCP (Model Context Protocol) servers",
  helpText: `
MCP servers extend the assistant's capabilities with external tools. Servers
are configured in the assistant's config.json under the mcp.servers key. Each
server uses one of three transport types:

  stdio             Local process communicating over stdin/stdout
  sse               Remote server using Server-Sent Events
  streamable-http   Remote server using Streamable HTTP transport

MCP server configuration changes are detected automatically by the running
assistant. You can also run 'vellum mcp reload' to trigger a manual reload.

Examples:
  $ assistant mcp list
  $ assistant mcp add my-server -t stdio -c npx -a my-mcp-server
  $ assistant mcp auth my-server
  $ assistant mcp remove my-server`,
  subcommands: [
    {
      name: "list",
      description: "List configured MCP servers and their status",
      options: [{ flags: "--json", description: "Output as JSON" }],
      helpText: `
Shows each configured MCP server with its current status and configuration:

  Name         The server identifier used in config.json
  Status       Health check result:
                 ✓  Connected and responding
                 ✗  Error or disabled
                 !  Needs authentication (OAuth required)
  Transport    stdio, sse, or streamable-http
  URL/Command  The server URL (sse/streamable-http) or command (stdio)
  Risk         Default risk level: low, medium, or high
  Allowed      Tool allowlist filter (if configured)
  Blocked      Tool blocklist filter (if configured)

Health checks run on the daemon side. With --json, outputs the raw server
list including health status.

Examples:
  $ assistant mcp list
  $ assistant mcp list --json`,
    },
    {
      name: "reload",
      description: "Reload MCP server connections in the running assistant",
      helpText: `
Signals the running assistant to disconnect and reconnect all MCP servers
using the current configuration from disk. Active sessions pick up new tools
on their next turn automatically. The assistant must be running.

Examples:
  $ vellum mcp reload
  $ vellum mcp reload   # after editing config.json to add a new server
  $ vellum mcp reload   # after running "vellum mcp auth <server>"`,
    },
    {
      // NOTE: the repeatable `-H, --header` collector option and the trailing
      // `--disabled` are registered imperatively in `mcp.ts` (array-accumulating
      // parser functions are not expressible as plain help data).
      name: "add",
      args: "<name>",
      description: "Add an MCP server configuration",
      options: [
        {
          flags: "-t, --transport-type <type>",
          description: "Transport type: stdio, sse, or streamable-http",
          required: true,
        },
        {
          flags: "-u, --url <url>",
          description: "Server URL (for sse/streamable-http)",
        },
        {
          flags: "-c, --command <cmd>",
          description: "Command to run (for stdio)",
        },
        {
          flags: "-a, --args <args...>",
          description: "Command arguments (for stdio)",
        },
        {
          flags: "-r, --risk <level>",
          description: "Default risk level: low, medium, or high",
          defaultValue: "high",
        },
      ],
      helpText: `
Arguments:
  name   Unique identifier for the server (used as the key in config.json)

Transport-specific requirements:
  stdio             Requires --command (and optional --args for arguments)
  sse               Requires --url pointing to the SSE endpoint
  streamable-http   Requires --url pointing to the HTTP endpoint

The --risk flag sets the default risk level for all tools from this server
(defaults to "high" if not specified). The server starts enabled unless
--disabled is passed.

The --header (-H) flag adds custom HTTP headers to sse/streamable-http
transports. Use it for Bearer Token or API Key authentication. The flag
is repeatable — pass multiple -H flags for multiple headers.

If a server with the same name already exists, the command fails. Remove the
existing server first with "assistant mcp remove <name>".

Examples:
  $ assistant mcp add my-server -t stdio -c npx -a my-mcp-server
  $ assistant mcp add remote-api -t streamable-http -u https://api.example.com/mcp -r medium
  $ assistant mcp add legacy-sse -t sse -u https://old.example.com/events --disabled
  $ assistant mcp add authed-api -t sse -u https://api.example.com/mcp -H 'Authorization: Bearer tok123'
  $ assistant mcp add apikey-srv -t streamable-http -u https://srv.example.com/mcp -H 'X-API-Key: sk_live_abc'`,
    },
    {
      name: "auth",
      args: "<name>",
      description: "Authenticate with an MCP server via OAuth",
      helpText: `
Arguments:
  name   Name of a configured MCP server to authenticate with

Only works with sse or streamable-http transports (stdio servers do not use
OAuth). Opens a browser for OAuth authorization with the remote server. The
running assistant handles the OAuth callback and token exchange.

The command waits up to 2.5 minutes for the user to complete the browser-based
OAuth flow. If the server already has valid cached tokens, the command succeeds
immediately without opening a browser. Tokens are cached locally for future use
by the assistant.

After successful authentication, the running assistant detects the change
automatically. You can also run 'vellum mcp reload' to apply immediately.

Examples:
  $ assistant mcp auth my-server
  $ assistant mcp auth remote-api`,
    },
    {
      name: "remove",
      args: "<name>",
      description: "Remove an MCP server configuration",
      helpText: `
Arguments:
  name   Name of the MCP server to remove

Removes the server entry from config.json and performs best-effort cleanup of
any stored OAuth credentials (tokens, client info, discovery metadata) for
sse/streamable-http servers. If no OAuth credentials exist, the cleanup is
silently skipped.

After removal, the running assistant detects the change automatically. You
can also run 'vellum mcp reload' to apply immediately.

Examples:
  $ assistant mcp remove my-server
  $ assistant mcp remove legacy-sse`,
    },
  ],
};
