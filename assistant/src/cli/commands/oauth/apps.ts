import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { getCliLogger } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AppRow {
  id: string;
  provider_key: string;
  client_id: string;
  created_at: number;
  updated_at: number;
}

/** Format an app row for CLI output, converting timestamps to ISO strings. */
function formatAppRow(row: AppRow) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    clientId: row.client_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Resolve a credential path input to its full internal format.
 *
 * The primary input format is `service:field` (e.g. `google:client_secret`),
 * which is split on the **last** colon and expanded to `credential/{service}/{field}`.
 *
 * Full internal paths (`credential/…` or `oauth_app/…`) are also accepted
 * and returned as-is for backwards compatibility.
 */
function resolveCredentialPath(input: string): string {
  if (input.startsWith("credential/") || input.startsWith("oauth_app/")) {
    return input;
  }

  const lastColon = input.lastIndexOf(":");
  if (lastColon < 1 || lastColon === input.length - 1) {
    return input;
  }

  const service = input.slice(0, lastColon);
  const field = input.slice(lastColon + 1);
  return `credential/${service}/${field}`;
}

export function registerAppCommands(oauth: Command): void {
  const apps = subcommand(oauth, "apps");

  // -----------------------------------------------------------------------
  // apps list
  // -----------------------------------------------------------------------

  subcommand(apps, "list").action(
    async (opts: { providerKey?: string }, cmd: Command) => {
      if (!opts.providerKey) {
        // The IPC route requires provider_key. To support listing all
        // apps, we first need to know the providers. For simplicity
        // and backward compatibility, list providers first, then
        // aggregate.
        const provR = await cliIpcCall<{
          providers: Array<{ provider_key: string }>;
        }>("oauth_providers_get", { queryParams: {} });

        if (!provR.ok) return exitFromIpcResult(provR);

        const allRows: ReturnType<typeof formatAppRow>[] = [];
        for (const p of provR.result?.providers ?? []) {
          const r = await cliIpcCall<{
            apps: AppRow[];
          }>("oauth_apps_get", {
            queryParams: { provider_key: p.provider_key },
          });
          if (r.ok && r.result?.apps) {
            allRows.push(...r.result.apps.map(formatAppRow));
          }
        }

        if (!shouldOutputJson(cmd)) {
          log.info(`Found ${allRows.length} app(s)`);
        }
        writeOutput(cmd, allRows);
        return;
      }

      const r = await cliIpcCall<{ apps: AppRow[] }>("oauth_apps_get", {
        queryParams: { provider_key: opts.providerKey },
      });

      if (!r.ok) return exitFromIpcResult(r);

      const rows = (r.result?.apps ?? []).map(formatAppRow);

      if (!shouldOutputJson(cmd)) {
        log.info(`Found ${rows.length} app(s)`);
      }

      writeOutput(cmd, rows);
    },
  );

  // -----------------------------------------------------------------------
  // apps get
  // -----------------------------------------------------------------------

  subcommand(apps, "get").action(
    async (
      opts: { id?: string; provider?: string; clientId?: string },
      cmd: Command,
    ) => {
      if (!opts.id && !opts.provider) {
        writeOutput(cmd, {
          ok: false,
          error:
            "Provide --id, --provider, or --provider + --client-id. Run 'assistant oauth apps list' to see all registered apps.",
        });
        process.exitCode = 1;
        return;
      }

      const queryParams: Record<string, string> = {};
      if (opts.id) queryParams.id = opts.id;
      if (opts.provider) queryParams.provider = opts.provider;
      if (opts.clientId) queryParams.client_id = opts.clientId;

      const r = await cliIpcCall<{ app: AppRow }>("oauth_apps_by_query_get", {
        queryParams,
      });

      if (!r.ok) {
        if (r.statusCode === 404) {
          const lookup = opts.id
            ? `id=${opts.id}`
            : opts.provider && opts.clientId
              ? `provider=${opts.provider}, clientId=${opts.clientId}`
              : `provider=${opts.provider}`;
          writeOutput(cmd, {
            ok: false,
            error: `No app found for ${lookup}. Run 'assistant oauth apps list' to see registered apps, or 'assistant oauth apps upsert --help' to register a new one.`,
          });
          process.exitCode = 1;
          return;
        }
        return exitFromIpcResult(r);
      }

      const row = r.result?.app;
      writeOutput(cmd, row ? formatAppRow(row) : null);
    },
  );

  // -----------------------------------------------------------------------
  // apps upsert
  // -----------------------------------------------------------------------

  subcommand(apps, "upsert").action(
    async (
      opts: {
        provider: string;
        clientId: string;
        clientSecret?: string;
        clientSecretCredentialPath?: string;
      },
      cmd: Command,
    ) => {
      if (opts.clientSecret && opts.clientSecretCredentialPath) {
        writeOutput(cmd, {
          ok: false,
          error:
            "Cannot provide both --client-secret and --client-secret-credential-path",
        });
        process.exitCode = 1;
        return;
      }

      const body: Record<string, unknown> = {
        provider_key: opts.provider,
        client_id: opts.clientId,
      };

      if (opts.clientSecret) {
        body.client_secret = opts.clientSecret;
      } else if (opts.clientSecretCredentialPath) {
        body.client_secret_credential_path = resolveCredentialPath(
          opts.clientSecretCredentialPath,
        );
      }

      const r = await cliIpcCall<{ app: AppRow }>("oauth_apps_upsert", {
        body,
      });

      if (!r.ok) {
        writeOutput(cmd, {
          ok: false,
          error: r.error ?? "Unknown error",
        });
        process.exitCode = 1;
        return;
      }

      const row = r.result?.app;
      if (row) {
        if (!shouldOutputJson(cmd)) {
          log.info(`Upserted app: ${row.id} (provider: ${row.provider_key})`);
        }
        writeOutput(cmd, formatAppRow(row));
      }
    },
  );

  // -----------------------------------------------------------------------
  // apps delete <id>
  // -----------------------------------------------------------------------

  subcommand(apps, "delete").action(
    async (id: string, _opts: unknown, cmd: Command) => {
      const r = await cliIpcCall<{ ok: boolean }>("oauth_apps_delete", {
        pathParams: { id },
      });

      if (!r.ok) {
        if (r.statusCode === 404) {
          writeOutput(cmd, {
            ok: false,
            error: `App not found: ${id}. Run 'assistant oauth apps list' to see registered apps and their IDs.`,
          });
          process.exitCode = 1;
          return;
        }
        return exitFromIpcResult(r);
      }

      if (!shouldOutputJson(cmd)) {
        log.info(`Deleted app: ${id}`);
      }

      writeOutput(cmd, { ok: true, id });
    },
  );
}
