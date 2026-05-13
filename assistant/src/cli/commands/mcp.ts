import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { openInHostBrowser } from "../lib/open-browser.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Shared types for IPC responses
// ---------------------------------------------------------------------------

interface McpServerEntry {
  id: string;
  status: string;
  transport: {
    type: string;
    url?: string;
    command?: string;
    args?: string[];
  };
  enabled: boolean;
  defaultRiskLevel: string;
  allowedTools?: string[];
  blockedTools?: string[];
}

// ---------------------------------------------------------------------------
// Auth polling helper
// ---------------------------------------------------------------------------

async function pollMcpAuthStatus(
  serverId: string,
  options: { intervalMs: number; timeoutMs: number },
): Promise<{ status: "complete" | "error"; error?: string }> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) =>
      setTimeout(resolve, options.intervalMs),
    );
    const result = await cliIpcCall<{ status: string; error?: string }>(
      "internal_mcp_auth_status",
      { pathParams: { serverId } },
    );
    if (result.ok && result.result?.status === "complete") {
      return { status: "complete" };
    }
    if (result.ok && result.result?.status === "error") {
      return { status: "error", error: result.result.error };
    }
    // The daemon returned an IPC-level error (ok: false) indicating the flow
    // was not found — most likely because the daemon restarted mid-poll and
    // lost the in-memory state.  Surface this immediately instead of looping
    // for the full 2.5 minutes and then reporting a generic timeout.
    if (
      !result.ok &&
      result.error &&
      result.error.includes("No active OAuth flow")
    ) {
      return {
        status: "error",
        error: `OAuth flow was lost (assistant may have restarted). Run 'assistant mcp auth ${serverId}' to retry.`,
      };
    }
    // Fail fast on any other real IPC error instead of looping for 2.5 minutes
    if (!result.ok && result.error) {
      return { status: "error", error: result.error };
    }
  }
  return {
    status: "error",
    error: "OAuth authorization timed out after 2.5 minutes",
  };
}

// ---------------------------------------------------------------------------
// Display helper for list output
// ---------------------------------------------------------------------------

function printServerEntry(entry: McpServerEntry): void {
  log.info(`  ${entry.id}`);
  log.info(`    Status:    ${entry.status}`);
  log.info(`    Transport: ${entry.transport?.type ?? "unknown"}`);
  if (entry.transport?.type === "stdio") {
    log.info(
      `    Command:   ${entry.transport.command} ${(
        entry.transport.args ?? []
      ).join(" ")}`,
    );
  } else if (entry.transport && "url" in entry.transport) {
    log.info(`    URL:       ${entry.transport.url}`);
  }
  log.info(`    Risk:      ${entry.defaultRiskLevel}`);
  if (entry.allowedTools) {
    log.info(`    Allowed:   ${entry.allowedTools.join(", ")}`);
  }
  if (entry.blockedTools) {
    log.info(`    Blocked:   ${entry.blockedTools.join(", ")}`);
  }
  log.info("");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMcpCommand(program: Command): void {
  registerCommand(program, {
    name: "mcp",
    transport: "ipc",
    description: "Manage MCP (Model Context Protocol) servers",
    build: (mcp) => {

  mcp.addHelpText(
    "after",
    `
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
  );

  mcp
    .command("list")
    .description("List configured MCP servers and their status")
    .option("--json", "Output as JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(async (opts: { json?: boolean }) => {
      const result = await cliIpcCall<{ servers: McpServerEntry[] }>(
        "internal_mcp_list",
      );

      if (!result.ok) {
        return exitFromIpcResult({
          ok: false,
          error: result.error,
          statusCode: result.statusCode,
        });
      }

      const servers = result.result?.servers ?? [];

      if (servers.length === 0) {
        if (opts.json) {
          process.stdout.write(JSON.stringify([], null, 2) + "\n");
        } else {
          log.info("No MCP servers configured.");
        }
        return;
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(servers, null, 2) + "\n");
        return;
      }

      log.info(`${servers.length} MCP server(s) configured:\n`);

      for (const entry of servers) {
        printServerEntry(entry);
      }
    });

  mcp
    .command("reload")
    .description("Reload MCP server connections in the running assistant")
    .addHelpText(
      "after",
      `
Signals the running assistant to disconnect and reconnect all MCP servers
using the current configuration from disk. Active sessions pick up new tools
on their next turn automatically. The assistant must be running.

Examples:
  $ vellum mcp reload
  $ vellum mcp reload   # after editing config.json to add a new server
  $ vellum mcp reload   # after running "vellum mcp auth <server>"`,
    )
    .action(async () => {
      const result = await cliIpcCall("internal_mcp_reload", { body: {} });
      if (!result.ok) {
        log.warn(
          `Could not signal reload: ${result.error}. ` +
            `Run 'assistant mcp reload' once the assistant is up.`,
        );
      } else {
        log.info(
          "MCP reload signal sent. The running assistant will reconnect servers shortly.",
        );
      }
    });

  mcp
    .command("add <name>")
    .description("Add an MCP server configuration")
    .requiredOption(
      "-t, --transport-type <type>",
      "Transport type: stdio, sse, or streamable-http",
    )
    .option("-u, --url <url>", "Server URL (for sse/streamable-http)")
    .option("-c, --command <cmd>", "Command to run (for stdio)")
    .option("-a, --args <args...>", "Command arguments (for stdio)")
    .option(
      "-r, --risk <level>",
      "Default risk level: low, medium, or high",
      "high",
    )
    .option("--disabled", "Add as disabled")
    .addHelpText(
      "after",
      `
Arguments:
  name   Unique identifier for the server (used as the key in config.json)

Transport-specific requirements:
  stdio             Requires --command (and optional --args for arguments)
  sse               Requires --url pointing to the SSE endpoint
  streamable-http   Requires --url pointing to the HTTP endpoint

The --risk flag sets the default risk level for all tools from this server
(defaults to "high" if not specified). The server starts enabled unless
--disabled is passed.

If a server with the same name already exists, the command fails. Remove the
existing server first with "assistant mcp remove <name>".

Examples:
  $ assistant mcp add my-server -t stdio -c npx -a my-mcp-server
  $ assistant mcp add remote-api -t streamable-http -u https://api.example.com/mcp -r medium
  $ assistant mcp add legacy-sse -t sse -u https://old.example.com/events --disabled`,
    )
    .action(
      async (
        name: string,
        opts: {
          transportType: string;
          url?: string;
          command?: string;
          args?: string[];
          risk: string;
          disabled?: boolean;
        },
      ) => {
        const result = await cliIpcCall<{ added: true }>(
          "internal_mcp_add",
          {
            body: {
              name,
              transportType: opts.transportType,
              url: opts.url,
              command: opts.command,
              args: opts.args,
              risk: opts.risk,
              disabled: opts.disabled,
            },
          },
        );

        if (!result.ok) {
          log.error(result.error ?? "Failed to add MCP server");
          process.exitCode = 1;
          return;
        }

        log.info(`Added MCP server "${name}" (${opts.transportType})`);
        log.info("The running assistant is reloading MCP servers now.");
      },
    );

  mcp
    .command("auth <name>")
    .description("Authenticate with an MCP server via OAuth")
    .addHelpText(
      "after",
      `
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
    )
    .action(async (name: string) => {
      // IPC-first path — attempt daemon-orchestrated flow (works on hosted assistants)
      const startResult = await cliIpcCall<{
        auth_url: string;
        state: string;
        already_authenticated?: boolean;
      }>("internal_mcp_auth_start", { body: { serverId: name } });

      if (startResult.ok && startResult.result?.already_authenticated) {
        log.info(`Server "${name}" is already authenticated.`);
        process.exit(0);
        return;
      }

      if (startResult.ok && startResult.result?.auth_url) {
        const authUrl = startResult.result.auth_url;
        log.info(`Opening browser for "${name}" OAuth authorization...`);
        openInHostBrowser(authUrl);
        log.info(`If the browser did not open, visit:\n${authUrl}`);
        log.info(
          "Waiting for authorization in browser... (press Ctrl+C to cancel)",
        );

        const finalStatus = await pollMcpAuthStatus(name, {
          intervalMs: 2_000,
          timeoutMs: 150_000, // matches existing OAUTH_TIMEOUT_MS
        });

        if (finalStatus.status === "complete") {
          log.info(`Authentication successful for "${name}".`);
          log.info(
            "The running assistant has picked up this change automatically.",
          );
          process.exit(0);
          return;
        }

        const errMsg = finalStatus.error ?? "Unknown error";
        if (errMsg.includes("denied") || errMsg.includes("cancelled")) {
          log.error(`Authorization cancelled for "${name}".`);
        } else if (errMsg.includes("timed out")) {
          log.error(
            `Authorization timed out for "${name}". Try again with: assistant mcp auth ${name}`,
          );
        } else {
          log.error(`OAuth failed for "${name}": ${errMsg}`);
        }
        process.exitCode = 1;
        return;
      }

      // Any !startResult.ok case: surface error and exit 1
      const ipcErrMsg = startResult.error ?? "Unknown error";
      if (
        ipcErrMsg.startsWith("Could not connect to assistant daemon") ||
        ipcErrMsg.startsWith("Unknown method:")
      ) {
        log.error(
          `MCP OAuth requires the assistant to be running. Is it running?`,
        );
      } else {
        log.error(`MCP OAuth failed via assistant: ${ipcErrMsg}`);
      }
      process.exitCode = 1;
    });

  mcp
    .command("remove <name>")
    .description("Remove an MCP server configuration")
    .addHelpText(
      "after",
      `
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
    )
    .action(async (name: string) => {
      const result = await cliIpcCall<{ removed: true }>(
        "internal_mcp_remove",
        { body: { name } },
      );

      if (!result.ok) {
        log.error(result.error ?? `Failed to remove MCP server "${name}".`);
        process.exitCode = 1;
        return;
      }

      log.info(`Removed MCP server "${name}".`);
      log.info(
        "The running assistant will pick up this change automatically. " +
          "Or run 'vellum mcp reload' to apply now.",
      );
    });
    },
  });
}
