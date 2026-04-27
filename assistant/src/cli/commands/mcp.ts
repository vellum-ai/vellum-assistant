import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Command } from "commander";

import { loadRawConfig, saveRawConfig } from "../../config/loader.js";
import type { McpConfig, McpServerConfig } from "../../config/schemas/mcp.js";
import { McpClient } from "../../mcp/client.js";
import {
  deleteMcpOAuthCredentials,
  McpOAuthProvider,
} from "../../mcp/mcp-oauth-provider.js";
import { getSignalsDir } from "../../util/platform.js";
import { log } from "../logger.js";

const HEALTH_CHECK_TIMEOUT_MS = 10_000;

export async function checkServerHealth(
  serverId: string,
  config: McpServerConfig,
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<string> {
  const client = new McpClient(serverId);
  try {
    await Promise.race([
      client.connect(config.transport),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        if (typeof t === "object" && "unref" in t) t.unref();
      }),
    ]);

    if (client.isConnected) {
      await client.disconnect();
      return "\u2713 Connected";
    }

    // connect() swallows errors — check lastError to distinguish auth from
    // transport failures (DNS, TLS, 500, stdio crash, etc.).
    const err = client.lastError;
    if (err) {
      const message = err.message;
      if (message.includes("timeout")) {
        return "\u2717 Timed out";
      }
      return `\u2717 Error: ${message}`;
    }

    return "! Needs authentication";
  } catch (err) {
    // Only the external timeout Promise can throw here (connect() never does).
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timeout")) {
      return "\u2717 Timed out";
    }
    return `\u2717 Error: ${message}`;
  }
}

/**
 * Write a signal file so the daemon's ConfigWatcher triggers an MCP reload.
 * Used by `mcp reload`, `mcp auth`, and any operation that needs the daemon
 * to reconnect MCP servers.
 */
function signalMcpReload(): void {
  try {
    const signalsDir = getSignalsDir();
    mkdirSync(signalsDir, { recursive: true });
    writeFileSync(join(signalsDir, "mcp-reload"), "");
  } catch {
    // Best-effort — the daemon may not be running or the directory may not exist.
  }
}

export function registerMcpCommand(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Manage MCP (Model Context Protocol) servers");

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

When output is a TTY, health checks run in parallel with live status updates.
In non-TTY mode (piped), checks run sequentially. With --json, outputs raw
server config without running health checks.

Examples:
  $ assistant mcp list
  $ assistant mcp list --json`,
    )
    .action(async (opts: { json?: boolean }) => {
      const raw = loadRawConfig();
      const mcpConfig = raw.mcp as Partial<McpConfig> | undefined;
      const servers = mcpConfig?.servers ?? {};
      const entries = Object.entries(servers) as [string, McpServerConfig][];

      if (entries.length === 0) {
        if (opts.json) {
          process.stdout.write(JSON.stringify([], null, 2) + "\n");
        } else {
          log.info("No MCP servers configured.");
        }
        return;
      }

      if (opts.json) {
        const result = entries
          .filter(([, config]) => config && typeof config === "object")
          .map(([id, config]) => ({ id, ...config }));
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        return;
      }

      log.info(`${entries.length} MCP server(s) configured:\n`);

      const isTTY = process.stdout.isTTY;

      if (isTTY) {
        // TTY path: print placeholders, run health checks in parallel, update in-place with ANSI codes
        let lineCount = 0;
        const healthChecks: {
          id: string;
          cfg: McpServerConfig;
          statusLine: number;
        }[] = [];

        for (const [id, cfg] of entries) {
          if (!cfg || typeof cfg !== "object") {
            log.info(`  ${id} (invalid config — skipped)\n`);
            lineCount += 2;
            continue;
          }
          const enabled = cfg.enabled !== false;
          const transport = cfg.transport;
          const risk = cfg.defaultRiskLevel ?? "high";
          const statusText = !enabled ? "✗ disabled" : "⏳ Checking...";

          log.info(`  ${id}`);
          lineCount++;
          const statusLine = lineCount;
          log.info(`    Status:    ${statusText}`);
          lineCount++;
          log.info(`    Transport: ${transport?.type ?? "unknown"}`);
          lineCount++;
          if (transport?.type === "stdio") {
            log.info(
              `    Command:   ${transport.command} ${(
                transport.args ?? []
              ).join(" ")}`,
            );
            lineCount++;
          } else if (transport && "url" in transport) {
            log.info(`    URL:       ${transport.url}`);
            lineCount++;
          }
          log.info(`    Risk:      ${risk}`);
          lineCount++;
          if (cfg.allowedTools) {
            log.info(`    Allowed:   ${cfg.allowedTools.join(", ")}`);
            lineCount++;
          }
          if (cfg.blockedTools) {
            log.info(`    Blocked:   ${cfg.blockedTools.join(", ")}`);
            lineCount++;
          }
          log.info("");
          lineCount++;

          if (enabled) {
            healthChecks.push({ id, cfg, statusLine });
          }
        }

        if (healthChecks.length === 0) return;

        // Run health checks in parallel, update status lines in-place with ANSI codes
        await Promise.all(
          healthChecks.map(async ({ id, cfg, statusLine }) => {
            const health = await checkServerHealth(id, cfg);
            const up = lineCount - statusLine;
            process.stdout.write(
              `\x1b[${up}A\r\x1b[2K    Status:    ${health}\x1b[${up}B\r`,
            );
          }),
        );
      } else {
        // Non-TTY path: run health checks sequentially, print final status directly (no ANSI codes)
        for (const [id, cfg] of entries) {
          if (!cfg || typeof cfg !== "object") {
            log.info(`  ${id} (invalid config — skipped)\n`);
            continue;
          }
          const enabled = cfg.enabled !== false;
          const transport = cfg.transport;
          const risk = cfg.defaultRiskLevel ?? "high";

          let statusText: string;
          if (!enabled) {
            statusText = "✗ disabled";
          } else {
            statusText = await checkServerHealth(id, cfg);
          }

          log.info(`  ${id}`);
          log.info(`    Status:    ${statusText}`);
          log.info(`    Transport: ${transport?.type ?? "unknown"}`);
          if (transport?.type === "stdio") {
            log.info(
              `    Command:   ${transport.command} ${(
                transport.args ?? []
              ).join(" ")}`,
            );
          } else if (transport && "url" in transport) {
            log.info(`    URL:       ${transport.url}`);
          }
          log.info(`    Risk:      ${risk}`);
          if (cfg.allowedTools) {
            log.info(`    Allowed:   ${cfg.allowedTools.join(", ")}`);
          }
          if (cfg.blockedTools) {
            log.info(`    Blocked:   ${cfg.blockedTools.join(", ")}`);
          }
          log.info("");
        }
      }

      // Health checks may leave MCP transports alive — force exit
      process.exit(0);
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
    .action(() => {
      signalMcpReload();
      log.info(
        "MCP reload signal sent. The running assistant will reconnect servers shortly.",
      );
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
      (
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
        const raw = loadRawConfig();
        if (!raw.mcp) raw.mcp = { servers: {} };
        const mcpConfig = raw.mcp as Record<string, unknown>;
        if (!mcpConfig.servers) mcpConfig.servers = {};
        const servers = mcpConfig.servers as Record<string, unknown>;

        if (servers[name]) {
          log.error(
            `MCP server "${name}" already exists. Remove it first with: assistant mcp remove ${name}`,
          );
          process.exitCode = 1;
          return;
        }

        let transport: Record<string, unknown>;
        switch (opts.transportType) {
          case "stdio":
            if (!opts.command) {
              log.error("--command is required for stdio transport");
              process.exitCode = 1;
              return;
            }
            transport = {
              type: "stdio",
              command: opts.command,
              args: opts.args ?? [],
            };
            break;
          case "sse":
          case "streamable-http":
            if (!opts.url) {
              log.error(
                `--url is required for ${opts.transportType} transport`,
              );
              process.exitCode = 1;
              return;
            }
            transport = { type: opts.transportType, url: opts.url };
            break;
          default:
            log.error(
              `Unknown transport type: ${opts.transportType}. Must be stdio, sse, or streamable-http`,
            );
            process.exitCode = 1;
            return;
        }

        if (!["low", "medium", "high"].includes(opts.risk)) {
          log.error(
            `Invalid risk level: ${opts.risk}. Must be low, medium, or high`,
          );
          process.exitCode = 1;
          return;
        }

        servers[name] = {
          transport,
          enabled: !opts.disabled,
          defaultRiskLevel: opts.risk,
        };

        saveRawConfig(raw);
        log.info(`Added MCP server "${name}" (${opts.transportType})`);
        log.info(
          "The running assistant will pick up this change automatically. " +
            "Or run 'vellum mcp reload' to apply now.",
        );
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
OAuth). Opens a browser for OAuth authorization with the remote server and
starts a local callback server to receive the authorization code.

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
      const raw = loadRawConfig();
      const mcpConfig = raw.mcp as Partial<McpConfig> | undefined;
      const servers = mcpConfig?.servers ?? {};
      const serverConfig = (servers as Record<string, McpServerConfig>)[name];

      if (!serverConfig) {
        log.error(
          `MCP server "${name}" not found. Add it first with: assistant mcp add`,
        );
        process.exitCode = 1;
        return;
      }

      const transport = serverConfig.transport;
      if (transport.type !== "sse" && transport.type !== "streamable-http") {
        log.error(
          `OAuth is only supported for sse/streamable-http transports (server "${name}" uses ${transport.type})`,
        );
        process.exitCode = 1;
        return;
      }

      // Validate URL early so we fail fast before starting the callback server
      let serverUrl: URL;
      try {
        serverUrl = new URL(transport.url);
      } catch {
        log.error(`Invalid URL for MCP server "${name}": ${transport.url}`);
        process.exitCode = 1;
        return;
      }

      const provider = new McpOAuthProvider(
        name,
        transport.url,
        /* interactive */ true,
      );
      // Clear stale client_info and discovery — the callback server uses a random port,
      // so any previously cached client_info has a mismatched redirect_uri.
      // Preserve tokens so they survive if this auth attempt fails.
      await provider.invalidateCredentials("client");
      await provider.invalidateCredentials("discovery");
      const { codePromise } = await provider.startCallbackServer();

      const OAUTH_TIMEOUT_MS = 150_000; // 2.5 min for browser interaction
      const TransportClass =
        transport.type === "sse"
          ? SSEClientTransport
          : StreamableHTTPClientTransport;
      const mcpTransport = new TransportClass(serverUrl, {
        authProvider: provider,
        requestInit: transport.headers
          ? { headers: transport.headers }
          : undefined,
      });

      const client = new Client({ name: "vellum-assistant", version: "1.0.0" });

      try {
        // Try connecting — if tokens are already cached, this succeeds immediately
        await client.connect(mcpTransport);
        provider.stopCallbackServer();
        await client.close();
        log.info(`Server "${name}" is already authenticated.`);
        return;
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) {
          provider.stopCallbackServer();
          try {
            await client.close();
          } catch {
            /* ignore */
          }
          log.error(`Failed to connect to "${name}": ${err}`);
          process.exitCode = 1;
          return;
        }
      }

      // UnauthorizedError — browser was opened by redirectToAuthorization().
      // Wait for the user to complete the OAuth flow.
      log.info(
        "Waiting for authorization in browser... (press Ctrl+C to cancel)",
      );

      let code: string;
      let oauthTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        code = await Promise.race([
          codePromise,
          new Promise<never>((_, reject) => {
            oauthTimer = setTimeout(
              () =>
                reject(
                  new Error("OAuth authorization timed out after 2.5 minutes"),
                ),
              OAUTH_TIMEOUT_MS,
            );
            if (typeof oauthTimer === "object" && "unref" in oauthTimer)
              oauthTimer.unref();
          }),
        ]);
        clearTimeout(oauthTimer);
      } catch (err) {
        clearTimeout(oauthTimer);
        provider.stopCallbackServer();
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("denied") || message.includes("cancelled")) {
          log.error(`Authorization cancelled for "${name}".`);
        } else if (message.includes("timed out")) {
          log.error(
            `Authorization timed out for "${name}". Try again with: assistant mcp auth ${name}`,
          );
        } else {
          log.error(`Authorization failed for "${name}": ${message}`);
        }
        process.exitCode = 1;
        return;
      }

      log.info("Authorization received. Exchanging token...");

      // Exchange auth code for tokens
      try {
        await mcpTransport.finishAuth(code);
      } catch (err) {
        provider.stopCallbackServer();
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        log.error(`Token exchange failed for "${name}": ${err}`);
        process.exitCode = 1;
        return;
      }

      // Clean up transport/client so the process can exit
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      provider.stopCallbackServer();

      log.info(`Authentication successful for "${name}".`);
      log.info(
        "The running assistant will pick up this change automatically. " +
          "Or run 'vellum mcp reload' to apply now.",
      );
      signalMcpReload();
      process.exit(0);
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
      const raw = loadRawConfig();
      const mcpConfig = raw.mcp as Record<string, unknown> | undefined;
      const servers = mcpConfig?.servers as Record<string, unknown> | undefined;

      if (!servers || !servers[name]) {
        log.error(`MCP server "${name}" not found.`);
        process.exitCode = 1;
        return;
      }

      // Best-effort cleanup of any OAuth credentials stored for this server
      const serverConfig = servers[name] as Record<string, unknown>;
      const transport = serverConfig?.transport as
        | Record<string, unknown>
        | undefined;
      if (transport?.type === "sse" || transport?.type === "streamable-http") {
        try {
          await deleteMcpOAuthCredentials(name);
        } catch {
          // Ignore — credentials may not exist
        }
      }

      delete servers[name];
      saveRawConfig(raw);
      log.info(`Removed MCP server "${name}".`);
      log.info(
        "The running assistant will pick up this change automatically. " +
          "Or run 'vellum mcp reload' to apply now.",
      );
    });
}
