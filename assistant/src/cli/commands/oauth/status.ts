import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { isWeakOpenModel } from "../../../util/weak-open-model.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

/**
 * Message shown when a provider has no active connections. Weak open models
 * loop through redundant discovery commands (channel checks, `oauth providers
 * get`, loading the OAuth setup skill) before rendering the connect button, so
 * they get an explicit single next action: render the core `oauth_connect`
 * surface directly. Capable models keep the terse default.
 */
export function noConnectionsMessage(provider: string): string {
  const base = `No active connections for ${provider}.`;
  if (isWeakOpenModel(process.env.__RESOLVED_MODEL)) {
    return (
      `${base}\nTo let the user connect, render the connect button: call ` +
      `\`ui_show\` with surface_type "oauth_connect" and ` +
      `data.providerKey "${provider}". That surface is always available — do ` +
      `not run further \`oauth\`/\`channels\` commands or load a setup skill ` +
      `just to display it.\n`
    );
  }
  return `${base}\nConnect with \`assistant oauth connect ${provider}\`.\n`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionSummary {
  id: string;
  account: string | null;
  grantedScopes: string[];
  status: string;
  expiresAt?: string | null;
  hasRefreshToken?: boolean;
}

// ---------------------------------------------------------------------------
// Text formatting helpers
// ---------------------------------------------------------------------------

function formatConnection(c: ConnectionSummary, mode: string): string {
  const lines: string[] = [];
  lines.push(`  ${c.account ?? "(no account)"}`);
  lines.push(`    Connection ID: ${c.id}`);
  lines.push(`    Status: ${c.status}`);
  if (c.grantedScopes.length > 0) {
    lines.push(`    Granted scopes: ${c.grantedScopes.join(", ")}`);
  } else {
    lines.push(`    Granted scopes: (none)`);
  }
  if (mode === "byo") {
    if (c.expiresAt) {
      lines.push(`    Expires: ${c.expiresAt}`);
    }
    if (c.hasRefreshToken !== undefined) {
      lines.push(`    Refresh token: ${c.hasRefreshToken ? "yes" : "no"}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerStatusCommand(oauth: Command): void {
  oauth
    .command("status <provider>")
    .description("Show OAuth connection status for a specified provider")
    .addHelpText(
      "after",
      `
Arguments:
  provider   Provider name (e.g. google, slack).
             Run 'assistant oauth providers list' to see all available providers.

The output includes connection IDs and account identifiers that can be used
as inputs to other commands:
  - 'assistant oauth disconnect <provider>' to remove a connection
  - 'assistant oauth request --provider <provider> --account <account>' to
    make authenticated requests as a specific account

Examples:
  $ assistant oauth status google
  $ assistant oauth status google --json`,
    )
    .action(
      async (
        provider: string,
        _opts: Record<string, unknown>,
        cmd: Command,
      ) => {
        try {
          const r = await cliIpcCall<{
            ok: boolean;
            provider: string;
            mode: string;
            connections: ConnectionSummary[];
          }>("oauth_status", {
            queryParams: { provider },
          });

          if (!r.ok) {
            return exitFromIpcResult(r);
          }

          const result = r.result!;
          const { connections, mode } = result;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
            return;
          }

          // Text output
          if (connections.length === 0) {
            process.stdout.write(noConnectionsMessage(provider));
            return;
          }

          const blocks = connections.map((c) => formatConnection(c, mode));
          process.stdout.write(
            `${provider} (${mode}) — ${connections.length} active connection(s):\n\n${blocks.join("\n\n")}\n`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeOutput(cmd, { ok: false, error: message });
          process.exitCode = 1;
        }
      },
    );
}
