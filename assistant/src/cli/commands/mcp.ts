import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { openInHostBrowser } from "../lib/open-browser.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { mcpHelp } from "./mcp.help.js";

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
    name: mcpHelp.name,
    transport: "ipc",
    description: mcpHelp.description,
    build: (mcp) => {
      applyCommandHelp(mcp, mcpHelp);

      subcommand(mcp, "list").action(async (opts: { json?: boolean }) => {
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

      subcommand(mcp, "reload").action(async () => {
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

      // `-H, --header` uses an array-accumulating collector, which the
      // declarative help contract cannot express — it is registered
      // imperatively here (with the trailing `--disabled` after it,
      // preserving option order).
      subcommand(mcp, "add")
        .option(
          "-H, --header <key:value>",
          "Custom HTTP header (repeatable, for sse/streamable-http). E.g. -H 'Authorization: Bearer tok123'",
          (val: string, acc: string[]) => {
            acc.push(val);
            return acc;
          },
          [] as string[],
        )
        .option("--disabled", "Add as disabled")
        .action(
          async (
            name: string,
            opts: {
              transportType: string;
              url?: string;
              command?: string;
              args?: string[];
              risk: string;
              header: string[];
              disabled?: boolean;
            },
          ) => {
            let headers: Record<string, string> | undefined;
            if (opts.header.length > 0) {
              headers = {};
              for (const h of opts.header) {
                const colonIdx = h.indexOf(":");
                if (colonIdx === -1) {
                  log.error(
                    `Invalid header format: "${h}". Expected "Key: Value".`,
                  );
                  process.exitCode = 1;
                  return;
                }
                headers[h.slice(0, colonIdx).trim()] = h
                  .slice(colonIdx + 1)
                  .trim();
              }
            }

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
                  headers,
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

      subcommand(mcp, "auth").action(async (name: string) => {
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

      subcommand(mcp, "remove").action(async (name: string) => {
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
