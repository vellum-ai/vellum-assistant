import type { AssistantEntry } from "./assistant-config.js";

/**
 * Resolve the URL for a runtime migration endpoint, taking the assistant's
 * topology into account.
 *
 * - For local/docker assistants, `runtimeUrl` is the loopback gateway and
 *   the runtime serves `/v1/migrations/<subpath>` directly. The CLI hits
 *   that path with guardian-token bearer auth.
 * - For platform-managed (cloud="vellum") assistants, `runtimeUrl` is the
 *   platform host (e.g. `https://platform.vellum.ai`). The platform's
 *   `MigrationViewSet` does NOT expose `export-to-gcs` or arbitrary runtime
 *   migration paths under `/v1/migrations/...`. The wildcard runtime proxy
 *   at `/v1/assistants/<id>/<path:rest>` is what forwards arbitrary runtime
 *   paths to the managed runtime — vembda's unified proxy bootstraps the
 *   guardian token internally for the runtime call. From the CLI side it's
 *   user-session auth.
 *
 * The `subpath` is appended to the migrations namespace verbatim
 * (e.g. `"export-to-gcs"`, `"import-from-gcs"`, `\`jobs/${jobId}\``).
 */
export function resolveRuntimeMigrationUrl(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  subpath: string,
): string {
  if (entry.cloud === "vellum") {
    return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/migrations/${subpath}`;
  }
  return `${entry.runtimeUrl}/v1/migrations/${subpath}`;
}

/**
 * Resolve the URL for a generic runtime endpoint under `/v1/<subpath>`,
 * taking the assistant's topology into account.
 *
 * - For local/docker assistants, `runtimeUrl` is the loopback gateway and
 *   the runtime serves `/v1/<subpath>` directly.
 * - For platform-managed (cloud="vellum") assistants the path is rewritten
 *   to the wildcard runtime proxy:
 *   `{platformUrl}/v1/assistants/<assistantId>/<subpath>`.
 *
 * The `subpath` is appended verbatim (e.g. `"identity"`).
 */
export function resolveRuntimeUrl(
  entry: Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId">,
  subpath: string,
): string {
  if (entry.cloud === "vellum") {
    return `${entry.runtimeUrl}/v1/assistants/${entry.assistantId}/${subpath}`;
  }
  return `${entry.runtimeUrl}/v1/${subpath}`;
}
