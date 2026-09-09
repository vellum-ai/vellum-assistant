import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { writeError, writeOutput } from "../../output.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wire shape of the daemon's `oauth_proxy_grant` result. Declared here so the
 * CLI stays off the daemon module graph.
 */
interface OAuthProxyGrantResponse {
  ok: true;
  provider: string;
  account: string | null;
  baseUrl: string;
  path: string;
  token: string;
  expiresAt: string;
  ttlSeconds: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Single-quote a value for `eval`, escaping embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatExportLines(result: OAuthProxyGrantResponse): string {
  const lines = [
    `export VELLUM_OAUTH_PROXY_BASE_URL=${shellQuote(result.baseUrl)}`,
    `export VELLUM_OAUTH_PROXY_TOKEN=${shellQuote(result.token)}`,
    `export VELLUM_OAUTH_PROXY_EXPIRES_AT=${shellQuote(result.expiresAt)}`,
  ];
  if (result.account) {
    lines.push(
      `export VELLUM_OAUTH_PROXY_ACCOUNT=${shellQuote(result.account)}`,
    );
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerProxyUrlCommand(oauth: Command): void {
  subcommand(oauth, "proxy-url").action(
    async (
      provider: string,
      opts: { account?: string; ttl?: string; export?: boolean },
      cmd: Command,
    ) => {
      try {
        let ttlSeconds: number | undefined;
        if (opts.ttl !== undefined) {
          const parsed = Number.parseInt(opts.ttl, 10);
          if (!Number.isInteger(parsed) || String(parsed) !== opts.ttl.trim()) {
            writeError(
              cmd,
              `Invalid --ttl "${opts.ttl}": expected a whole number of seconds.`,
            );
            process.exitCode = 2;
            return;
          }
          ttlSeconds = parsed;
        }

        const r = await cliIpcCall<OAuthProxyGrantResponse>(
          "oauth_proxy_grant",
          {
            body: {
              provider,
              ...(opts.account && { account: opts.account }),
              ...(ttlSeconds !== undefined && { ttlSeconds }),
            },
          },
        );

        if (!r.ok) {
          return exitFromIpcResult(r);
        }

        const result = r.result!;

        if (opts.export) {
          process.stdout.write(formatExportLines(result));
          return;
        }

        writeOutput(cmd, result);
      } catch (err) {
        // `--export` output is eval'd, so a failure reports through the
        // format-aware envelope rather than putting JSON on stdout.
        const message = err instanceof Error ? err.message : String(err);
        writeError(cmd, message);
        process.exitCode = 1;
      }
    },
  );
}
