import {
  findAssistantByName,
  loadAllAssistants,
  getDaemonPidPath,
  removeAssistantEntry,
  saveAssistantEntry,
  setActiveAssistant,
} from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  loadGuardianToken,
  leaseGuardianToken,
  computeDeviceId,
} from "../lib/guardian-token.js";
import {
  readPlatformToken,
  getPlatformUrl,
  hatchAssistant,
  checkExistingPlatformAssistant,
  platformPollJobStatus,
  platformImportBundleFromGcs,
  platformImportPreflightFromGcs,
  platformRequestSignedUrl,
  VersionMismatchError,
  ensureSelfHostedLocalRegistration,
  readGatewayCredential,
  reprovisionAssistantApiKey,
  injectCredentialsIntoAssistant,
  fetchCurrentUser,
  fetchOrganizationId,
} from "../lib/platform-client.js";
import {
  localRuntimeExportToGcs,
  localRuntimeIdentity,
  localRuntimeImportFromGcs,
  localRuntimePollJobStatus,
  MigrationInProgressError,
} from "../lib/local-runtime-client.js";
import { pollJobUntilDone } from "../lib/job-polling.js";
import {
  hatchDocker,
  retireDocker,
  sleepContainers,
  dockerResourceNames,
} from "../lib/docker.js";
import { hatchLocal } from "../lib/hatch-local.js";
import { retireLocal } from "../lib/retire-local.js";
import { validateAssistantName } from "../lib/retire-archive.js";
import { stopProcessByPidFile } from "../lib/process.js";
import { fetchCurrentVersion } from "../lib/upgrade-lifecycle.js";
import { compareVersions } from "../lib/version-compat.js";
import { join } from "node:path";

function printHelp(): void {
  console.log(
    "Usage: vellum teleport --from <assistant> <--local | --docker | --platform> [name] [options]",
  );
  console.log("");
  console.log(
    "Transfer assistant data between local, docker, and platform environments.",
  );
  console.log("");
  console.log(
    "The --from flag specifies the source assistant to export data from.",
  );
  console.log(
    "Exactly one environment flag (--local, --docker, --platform) specifies",
  );
  console.log(
    "the target environment. An optional name after the environment flag",
  );
  console.log(
    "targets an existing assistant (overwriting its data) or names a newly",
  );
  console.log(
    "hatched one. If no name is given, a new assistant is hatched with an",
  );
  console.log("auto-generated name.");
  console.log("");
  console.log(
    "The source and target must be different environments. Same-environment",
  );
  console.log("transfers (e.g. local to local) are not supported.");
  console.log("");
  console.log(
    "For local-to-docker and docker-to-local transfers, the source assistant",
  );
  console.log(
    "is automatically retired after a successful import to free up ports and",
  );
  console.log("avoid resource conflicts. Use --keep-source to skip this.");
  console.log("");
  console.log("Environment flags:");
  console.log("  --local [name]      Target a local bare-metal assistant");
  console.log("  --docker [name]     Target a docker assistant");
  console.log("  --platform [name]   Target a platform-hosted assistant");
  console.log("");
  console.log("Options:");
  console.log(
    "  --from <name>       Source assistant to export data from (required)",
  );
  console.log(
    "  --keep-source       Do not retire the source after local/docker transfers",
  );
  console.log(
    "  --dry-run           Preview the transfer without applying changes.",
  );
  console.log(
    "                      If the target exists, runs preflight analysis.",
  );
  console.log(
    "                      If the target would be hatched, shows what would happen",
  );
  console.log("                      without creating anything.");
  console.log("  --help, -h          Show this help");
  console.log("");
  console.log("Examples:");
  console.log("  vellum teleport --from my-local --docker");
  console.log(
    "      Hatch a new docker assistant, import data, and retire my-local",
  );
  console.log("");
  console.log("  vellum teleport --from my-local --docker my-docker");
  console.log(
    "      Import data from my-local into existing docker assistant my-docker",
  );
  console.log(
    "      (or hatch a new docker assistant named my-docker if it doesn't exist)",
  );
  console.log("");
  console.log("  vellum teleport --from my-local --platform");
  console.log(
    "      Hatch a new platform assistant and import data from my-local",
  );
  console.log("");
  console.log("  vellum teleport --from my-cloud --local my-new-local");
  console.log(
    "      Import data from platform assistant my-cloud into local assistant",
  );
  console.log("");
  console.log("  vellum teleport --from my-docker --local --keep-source");
  console.log(
    "      Transfer to a new local assistant but keep the docker source running",
  );
  console.log("");
  console.log(
    "  vellum teleport --from staging --docker staging-copy --dry-run",
  );
  console.log("      Preview what would be imported without applying changes");
}

export function parseArgs(argv: string[]): {
  from: string | undefined;
  to: string | undefined;
  targetEnv: "local" | "docker" | "platform" | undefined;
  targetName: string | undefined;
  keepSource: boolean;
  dryRun: boolean;
  help: boolean;
} {
  let from: string | undefined;
  let to: string | undefined;
  let targetEnv: "local" | "docker" | "platform" | undefined;
  let targetName: string | undefined;
  let keepSource = false;
  let dryRun = false;
  let help = false;

  const envFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from" && i + 1 < argv.length) {
      if (argv[i + 1].startsWith("--")) {
        continue;
      }
      from = argv[++i];
    } else if (arg === "--to" && i + 1 < argv.length) {
      if (argv[i + 1].startsWith("--")) {
        continue;
      }
      to = argv[++i];
    } else if (
      arg === "--local" ||
      arg === "--docker" ||
      arg === "--platform"
    ) {
      const env = arg.slice(2) as "local" | "docker" | "platform";
      envFlags.push(env);
      targetEnv = env;
      // Peek at next arg for optional target name
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        targetName = argv[++i];
      }
    } else if (arg === "--keep-source") {
      keepSource = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  if (envFlags.length > 1) {
    console.error(
      "Error: Only one environment flag (--local, --docker, --platform) may be specified.",
    );
    process.exit(1);
  }

  return { from, to, targetEnv, targetName, keepSource, dryRun, help };
}

function resolveCloud(entry: AssistantEntry): string {
  return (
    entry.cloud || (entry.project ? "gcp" : entry.sshUser ? "custom" : "local")
  );
}

// ---------------------------------------------------------------------------
// Auth helper — same pattern as restore.ts
// ---------------------------------------------------------------------------

async function getAccessToken(
  runtimeUrl: string,
  assistantId: string,
  displayName: string,
  options?: { forceRefresh?: boolean },
): Promise<string> {
  // When forceRefresh is set (e.g. after a runtime 401 on the cached token)
  // we skip the cache and lease a brand-new token from the gateway, so a
  // stale-but-unexpired token can't keep failing on every retry.
  if (!options?.forceRefresh) {
    const tokenData = loadGuardianToken(assistantId);

    if (tokenData && new Date(tokenData.accessTokenExpiresAt) > new Date()) {
      return tokenData.accessToken;
    }
  }

  try {
    const freshToken = await leaseGuardianToken(runtimeUrl, assistantId);
    return freshToken.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(
        `Error: Could not connect to assistant '${displayName}'. Is it running?`,
      );
      console.error(`Try: vellum wake ${displayName}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Detect a 401 Unauthorized raised by `localRuntimeExportToGcs` /
 * `localRuntimeImportFromGcs` / `localRuntimeIdentity`. They throw Error
 * with a message of the form `"Local runtime <op> failed (401): ..."` or
 * `"Failed to fetch runtime identity: 401 ..."` when the gateway rejects
 * the cached guardian token.
 */
function isRuntime401(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Local runtime [^(]*failed \(401\)/.test(msg) ||
    /Failed to fetch runtime identity: 401\b/.test(msg)
  );
}

/**
 * Run a runtime kickoff (`localRuntimeExportToGcs` / `localRuntimeImportFromGcs`)
 * with a one-shot refresh-and-retry on 401. Matches the pre-rewrite
 * `exportViaHttp`/`importViaHttp` behavior: if the cached guardian token is
 * stale-but-unexpired and the runtime returns 401, we lease a fresh token
 * and retry once. Any other error — or a repeated 401 on the refreshed token
 * — propagates to the caller.
 */
async function callRuntimeWithAuthRetry<T>(
  runtimeUrl: string,
  assistantId: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const firstToken = await getAccessToken(runtimeUrl, assistantId, assistantId);
  try {
    return await fn(firstToken);
  } catch (err) {
    if (!isRuntime401(err)) {
      throw err;
    }
    const refreshedToken = await getAccessToken(
      runtimeUrl,
      assistantId,
      assistantId,
      { forceRefresh: true },
    );
    return await fn(refreshedToken);
  }
}

// ---------------------------------------------------------------------------
// Summary response shapes (reused by the GCS job result payload)
// ---------------------------------------------------------------------------

interface PreflightFileEntry {
  path: string;
  action: string;
}

interface StructuredError {
  code: string;
  message: string;
  path?: string;
}

interface PreflightResponse {
  can_import: boolean;
  validation?: {
    is_valid: false;
    errors: StructuredError[];
  };
  files?: PreflightFileEntry[];
  summary?: {
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    total_files: number;
  };
  conflicts?: StructuredError[];
}

interface ImportResponse {
  success: boolean;
  reason?: string;
  errors?: StructuredError[];
  message?: string;
  warnings?: string[];
  summary?: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
  credentialsImported?: {
    total: number;
    succeeded: number;
    failed: number;
    failedAccounts: string[];
    skippedPlatform?: number;
  };
}

// ---------------------------------------------------------------------------
// Export from source — unified GCS flow
//
// Every source (local, docker, platform) produces a `bundleKey` referring to
// a bundle sitting in GCS. The CLI never holds the bundle bytes.
// ---------------------------------------------------------------------------

async function exportFromAssistant(
  entry: AssistantEntry,
  cloud: string,
  bundlePlatformUrl?: string,
): Promise<{ bundleKey: string }> {
  const platformToken = readPlatformToken();
  if (!platformToken) {
    console.error(
      "Not logged in. Run 'vellum login' first (required for GCS-based teleport).",
    );
    process.exit(1);
  }

  if (cloud === "local" || cloud === "docker") {
    // Ask the source runtime which version it's running before requesting
    // the signed upload URL. The bundle is produced by the daemon (not the
    // CLI), so the daemon's version is what defines the bundle's
    // `min_runtime_version`. Stamping with `cliPkg.version` instead would
    // record an inaccurate compatibility band whenever the CLI/daemon have
    // drifted (a normal case in real usage — `vellum upgrade` swaps the
    // daemon, the CLI is updated separately).
    let sourceRuntimeVersion: string;
    try {
      const identity = await callRuntimeWithAuthRetry(
        entry.runtimeUrl,
        entry.assistantId,
        async (token) => localRuntimeIdentity(entry, token),
      );
      sourceRuntimeVersion = identity.version;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Error: Could not fetch runtime identity from '${entry.assistantId}': ${msg}`,
      );
      process.exit(1);
    }

    // Request a signed upload URL from the platform instance that will
    // eventually own the bundle (i.e. the one the importer will read from).
    // Passing the target's runtime URL here keeps upload and download on
    // the same platform — otherwise a non-default/stale platform URL would
    // cause the import to look at an empty object.
    const { url: uploadUrl, bundleKey } = await platformRequestSignedUrl(
      {
        operation: "upload",
        minRuntimeVersion: sourceRuntimeVersion,
        maxRuntimeVersion: null,
      },
      platformToken,
      bundlePlatformUrl,
    );

    // Wrap the kickoff in a one-shot refresh-and-retry helper so a stale-but-
    // unexpired cached guardian token surfaces as 401 → re-lease → retry
    // rather than a terminal failure. `accessToken` below is whichever token
    // succeeded on the kickoff; we reuse it for polling so the runtime sees a
    // consistent credential throughout the migration.
    let jobId: string;
    let accessToken: string;
    try {
      const result = await callRuntimeWithAuthRetry(
        entry.runtimeUrl,
        entry.assistantId,
        async (token) => {
          const r = await localRuntimeExportToGcs(entry, token, {
            uploadUrl,
            description: "teleport export",
          });
          return { jobId: r.jobId, token };
        },
      );
      jobId = result.jobId;
      accessToken = result.token;
    } catch (err) {
      if (err instanceof MigrationInProgressError) {
        // Fail fast — the existing job is writing to a different GCS object
        // (its caller's signed URL, not ours), so polling it would leave us
        // pointing at an empty/unrelated bundle. Surface the existing job id
        // so the user can decide whether to wait or investigate.
        console.error(
          `Error: Another teleport export is already in progress on '${entry.assistantId}' (job ${err.existingJobId}). Wait for it to finish or check its status, then re-run.`,
        );
        process.exit(1);
      }
      throw err;
    }

    console.log(`Export started (job ${jobId})...`);

    const terminal = await pollJobUntilDone({
      label: "local-runtime export",
      poll: () => localRuntimePollJobStatus(entry, accessToken, jobId),
      // Large exports can take longer than a guardian-token lease. If the
      // runtime returns 401 mid-poll, re-lease a fresh token and rebind the
      // closure variable so the next poll uses it.
      refreshOn401: async () => {
        accessToken = await getAccessToken(
          entry.runtimeUrl,
          entry.assistantId,
          entry.assistantId,
          { forceRefresh: true },
        );
      },
    });

    if (terminal.status === "failed") {
      console.error(`Export failed: ${terminal.error}`);
      process.exit(1);
    }

    return { bundleKey };
  }

  if (cloud === "vellum") {
    // Ask the managed runtime which version it's running so the signed-URL
    // request records the bundle's actual `min_runtime_version`. The
    // platform-managed runtime is the exporter; the CLI version is
    // unrelated. Routed via the wildcard proxy with platform-token auth
    // (resolveRuntimeUrl + migrationRequestHeaders inside
    // localRuntimeIdentity).
    let sourceRuntimeVersion: string;
    try {
      const identity = await localRuntimeIdentity(entry, platformToken);
      sourceRuntimeVersion = identity.version;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Error: Could not fetch runtime identity from '${entry.assistantId}': ${msg}`,
      );
      process.exit(1);
    }

    // Platform source — request a signed upload URL on the same platform
    // instance the bundle will eventually be imported from, then ask the
    // managed runtime to export directly to GCS. The runtime endpoint is
    // reached via the platform's wildcard runtime proxy at
    // `/v1/assistants/<id>/migrations/export-to-gcs` — the
    // `localRuntimeExportToGcs` helper uses `resolveRuntimeMigrationUrl` to
    // pick that shape for `cloud === "vellum"` and `migrationRequestHeaders`
    // to send platform-token auth (no guardian-token bootstrap).
    const { url: uploadUrl, bundleKey } = await platformRequestSignedUrl(
      {
        operation: "upload",
        minRuntimeVersion: sourceRuntimeVersion,
        maxRuntimeVersion: null,
      },
      platformToken,
      bundlePlatformUrl,
    );

    let jobId: string;
    let exportPlatformToken = platformToken;
    try {
      ({ jobId } = await localRuntimeExportToGcs(entry, exportPlatformToken, {
        uploadUrl,
        description: "teleport export",
      }));
    } catch (err) {
      if (err instanceof MigrationInProgressError) {
        console.error(
          `Error: Another teleport export is already in progress on '${entry.assistantId}' (job ${err.existingJobId}). Wait for it to finish or check its status, then re-run.`,
        );
        process.exit(1);
      }
      throw err;
    }

    console.log(`Export started (job ${jobId})...`);

    // Polling also goes through the wildcard proxy — `localRuntimePollJobStatus`
    // builds `/v1/assistants/<id>/migrations/jobs/<jobId>` for `cloud === "vellum"`
    // (the dedicated `/v1/migrations/jobs/{id}/` endpoint queries platform-side
    // ImportJob records and 404s on runtime-created job IDs).
    const terminal = await pollJobUntilDone({
      label: "platform export",
      poll: () => localRuntimePollJobStatus(entry, exportPlatformToken, jobId),
      // The platform token is normally static per-process, but re-reading the
      // on-disk credential covers the case where the user ran `vellum login`
      // in another terminal during a long migration. A persistent 401 after
      // a re-read surfaces to the caller with a clear next step.
      refreshOn401: async () => {
        const refreshed = readPlatformToken();
        if (!refreshed) {
          throw new Error(
            "Platform auth expired during export and no credential was found on disk. Run 'vellum login' and retry.",
          );
        }
        exportPlatformToken = refreshed;
      },
    });

    if (terminal.status === "failed") {
      console.error(`Export failed: ${terminal.error}`);
      process.exit(1);
    }

    return { bundleKey };
  }

  console.error(
    "Teleport only supports local, docker, and platform assistants as source.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Import into target — unified GCS flow
// ---------------------------------------------------------------------------

async function importToAssistant(
  entry: AssistantEntry,
  cloud: string,
  bundleKey: string,
  dryRun: boolean,
  bundlePlatformUrl?: string,
): Promise<void> {
  const platformToken = readPlatformToken();
  if (!platformToken) {
    console.error(
      "Not logged in. Run 'vellum login' first (required for GCS-based teleport).",
    );
    process.exit(1);
  }

  if (cloud === "vellum") {
    // Platform target — the bundle is already in GCS; kick off preflight or
    // async import via the unified job-status endpoint.
    if (dryRun) {
      console.log("Running preflight analysis...\n");

      const preflight = await platformImportPreflightFromGcs(
        bundleKey,
        platformToken,
        entry.runtimeUrl,
      );

      if (preflight.statusCode === 401 || preflight.statusCode === 403) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }

      if (preflight.statusCode === 404) {
        console.error("Assistant not found or not running.");
        process.exit(1);
      }

      if (
        preflight.statusCode === 502 ||
        preflight.statusCode === 503 ||
        preflight.statusCode === 504
      ) {
        console.error(
          `Assistant is unreachable. Try 'vellum wake ${entry.assistantId}'.`,
        );
        process.exit(1);
      }

      if (preflight.statusCode !== 200) {
        console.error(
          `Error: Preflight check failed (${preflight.statusCode}): ${JSON.stringify(preflight.body)}`,
        );
        process.exit(1);
      }

      const result = preflight.body as unknown as PreflightResponse;
      printPreflightSummary(result);
      return;
    }

    console.log("Importing data...");

    const importResult = await platformImportBundleFromGcs(
      bundleKey,
      platformToken,
      entry.runtimeUrl,
    );

    if (importResult.statusCode === 401 || importResult.statusCode === 403) {
      console.error("Authentication failed. Run 'vellum login' to refresh.");
      process.exit(1);
    }

    if (importResult.statusCode === 404) {
      console.error("Assistant not found or not running.");
      process.exit(1);
    }

    if (
      importResult.statusCode === 502 ||
      importResult.statusCode === 503 ||
      importResult.statusCode === 504
    ) {
      console.error(
        `Assistant is unreachable. Try 'vellum wake ${entry.assistantId}'.`,
      );
      process.exit(1);
    }

    if (importResult.statusCode !== 202 && importResult.statusCode !== 200) {
      console.error(`Error: Import failed (${importResult.statusCode})`);
      process.exit(1);
    }

    let finalBody: Record<string, unknown> = importResult.body;

    if (importResult.statusCode === 202) {
      const jobId = (importResult.body as { job_id?: string }).job_id;
      if (!jobId) {
        console.error("Error: Import accepted but no job ID returned.");
        process.exit(1);
      }

      let importPlatformToken = platformToken;
      const terminal = await pollJobUntilDone({
        label: "platform import",
        poll: () =>
          platformPollJobStatus(jobId, importPlatformToken, entry.runtimeUrl),
        refreshOn401: async () => {
          const refreshed = readPlatformToken();
          if (!refreshed) {
            throw new Error(
              "Platform auth expired during import and no credential was found on disk. Run 'vellum login' and retry.",
            );
          }
          importPlatformToken = refreshed;
        },
      });

      if (terminal.status === "failed") {
        console.error(`Import failed: ${terminal.error}`);
        process.exit(1);
      }

      finalBody = (terminal.result as Record<string, unknown>) ?? {};
    }

    const result = finalBody as unknown as ImportResponse;
    printImportSummary(result);
    return;
  }

  if (cloud === "local" || cloud === "docker") {
    if (dryRun) {
      // TODO(cli): support dry-run against local targets
      console.error(
        "Error: --dry-run is not yet supported for local or docker targets (no preflight-from-gcs endpoint on the runtime).",
      );
      process.exit(1);
    }

    // Ask the platform for a signed download URL and hand it to the local
    // runtime. The runtime streams the bundle straight out of GCS — the CLI
    // never touches the bytes. The URL must target the same platform the
    // bundle was uploaded to; otherwise the object won't exist on this
    // platform's GCS bucket.
    //
    // The platform's vbundle version gate compares the **target runtime's**
    // version against the bundle's compatibility range. The CLI and the
    // target assistant's daemon can diverge (assistants upgrade
    // independently), so we MUST query the target runtime's `/v1/identity`
    // for its version rather than sending `cliPkg.version`. Sending the CLI
    // version here would falsely 422 a valid import (or pass a bundle the
    // target can't actually load) whenever the two drift apart.
    let targetRuntimeVersion: string;
    try {
      const identity = await callRuntimeWithAuthRetry(
        entry.runtimeUrl,
        entry.assistantId,
        (token) => localRuntimeIdentity(entry, token),
      );
      targetRuntimeVersion = identity.version;
    } catch (err) {
      // Surface and abort — silently falling back to `cliPkg.version` would
      // re-introduce the bug this code is fixing. If the runtime is
      // unreachable, the import would fail downstream anyway.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Error: Could not read target runtime version from '${entry.assistantId}': ${msg}`,
      );
      console.error(`Try: vellum wake ${entry.assistantId}`);
      process.exit(1);
    }

    let bundleUrl: string;
    try {
      const result = await platformRequestSignedUrl(
        {
          operation: "download",
          bundleKey,
          targetRuntimeVersion,
        },
        platformToken,
        bundlePlatformUrl,
      );
      bundleUrl = result.url;
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        // 422 version_mismatch is terminal — the bundle's runtime range and
        // the target runtime's version don't overlap. Surface the
        // platform-formatted message and exit; do NOT retry.
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    console.log("Importing data...");

    let jobId: string;
    let accessToken: string;
    try {
      const result = await callRuntimeWithAuthRetry(
        entry.runtimeUrl,
        entry.assistantId,
        async (token) => {
          const r = await localRuntimeImportFromGcs(entry, token, {
            bundleUrl,
          });
          return { jobId: r.jobId, token };
        },
      );
      jobId = result.jobId;
      accessToken = result.token;
    } catch (err) {
      if (err instanceof MigrationInProgressError) {
        // Fail fast — the existing job is importing someone else's bundle
        // (the original caller's), not ours. Polling it would report success
        // on an import that wasn't the one we just kicked off.
        console.error(
          `Error: Another teleport import is already in progress on '${entry.assistantId}' (job ${err.existingJobId}). Wait for it to finish or check its status, then re-run.`,
        );
        process.exit(1);
      }
      throw err;
    }

    const terminal = await pollJobUntilDone({
      label: "local-runtime import",
      poll: () => localRuntimePollJobStatus(entry, accessToken, jobId),
      refreshOn401: async () => {
        accessToken = await getAccessToken(
          entry.runtimeUrl,
          entry.assistantId,
          entry.assistantId,
          { forceRefresh: true },
        );
      },
    });

    if (terminal.status === "failed") {
      console.error(`Import failed: ${terminal.error}`);
      process.exit(1);
    }

    const result = ((terminal.result as Record<string, unknown>) ??
      {}) as unknown as ImportResponse;
    printImportSummary(result);
    return;
  }

  console.error(
    "Teleport only supports local, docker, and platform assistants as target.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve or hatch target assistant
// ---------------------------------------------------------------------------

export async function resolveOrHatchTarget(
  targetEnv: "local" | "docker" | "platform",
  targetName?: string,
): Promise<AssistantEntry> {
  // If a name is provided, try to find an existing assistant
  if (targetName) {
    const existing = findAssistantByName(targetName);
    if (existing) {
      // Validate the existing assistant's cloud matches the requested env
      const existingCloud = resolveCloud(existing);
      const normalizedExisting =
        existingCloud === "vellum" ? "platform" : existingCloud;
      if (normalizedExisting !== targetEnv) {
        console.error(
          `Error: Assistant '${targetName}' is a ${normalizedExisting} assistant, not ${targetEnv}. ` +
            `Use --${normalizedExisting} to target it.`,
        );
        process.exit(1);
      }
      console.log(`Target: ${targetName} (${targetEnv})`);
      return existing;
    }

    // Name not found — will hatch.
    if (targetEnv === "platform") {
      // Platform API doesn't accept custom names — warn and ignore
      console.log(
        `Note: Platform assistants receive a server-assigned ID. The name '${targetName}' will not be used.`,
      );
    } else {
      // Validate the name before passing to hatch
      try {
        validateAssistantName(targetName);
      } catch {
        console.error(
          "Error: Target name contains invalid characters (path separators or traversal segments are not allowed).",
        );
        process.exit(1);
      }
    }
  }

  // Hatch a new assistant in the target environment
  if (targetEnv === "local") {
    const beforeIds = new Set(loadAllAssistants().map((e) => e.assistantId));
    await hatchLocal("vellum", targetName ?? null, false, false, {});
    const entry = targetName
      ? findAssistantByName(targetName)
      : (loadAllAssistants().find((e) => !beforeIds.has(e.assistantId)) ??
        null);
    if (!entry) {
      console.error("Error: Could not find the newly hatched local assistant.");
      process.exit(1);
    }
    console.log(`Hatched new local assistant: ${entry.assistantId}`);
    return entry;
  }

  if (targetEnv === "docker") {
    const beforeIds = new Set(loadAllAssistants().map((e) => e.assistantId));
    await hatchDocker("vellum", false, targetName ?? null, false, {});
    const entry = targetName
      ? findAssistantByName(targetName)
      : (loadAllAssistants().find((e) => !beforeIds.has(e.assistantId)) ??
        null);
    if (!entry) {
      console.error(
        "Error: Could not find the newly hatched docker assistant.",
      );
      process.exit(1);
    }
    console.log(`Hatched new docker assistant: ${entry.assistantId}`);
    return entry;
  }

  if (targetEnv === "platform") {
    const token = readPlatformToken();
    if (!token) {
      console.error("Not logged in. Run 'vellum login' first.");
      process.exit(1);
    }

    const { assistant: result, reusedExisting } = await hatchAssistant(token);

    // Defensive safety net — should not happen because of the pre-check in
    // teleport(), but guards against a TOCTOU race between the pre-check and
    // hatch (e.g. another client hatches in the GCS-upload window).
    if (reusedExisting) {
      const entry: AssistantEntry = {
        assistantId: result.id,
        runtimeUrl: getPlatformUrl(),
        cloud: "vellum",
        species: "vellum",
        hatchedAt: new Date().toISOString(),
      };
      saveAssistantEntry(entry);
      console.error(
        `Error: You already have a platform assistant '${result.id}'.`,
      );
      console.error(
        `Retire it first with 'vellum retire ${result.id}', then retry the teleport.`,
      );
      process.exit(1);
    }

    const entry: AssistantEntry = {
      assistantId: result.id,
      runtimeUrl: getPlatformUrl(),
      cloud: "vellum",
      species: "vellum",
      hatchedAt: new Date().toISOString(),
    };
    saveAssistantEntry(entry);
    setActiveAssistant(result.id);
    console.log(`Hatched new platform assistant: ${result.id}`);
    return entry;
  }

  console.error(`Error: Unknown target environment '${targetEnv}'.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Summary printing — matches restore.ts format
// ---------------------------------------------------------------------------

function printPreflightSummary(result: PreflightResponse): void {
  if (!result.can_import) {
    if (result.validation?.errors?.length) {
      console.error("Import blocked by validation errors:");
      for (const err of result.validation.errors) {
        console.error(`  - ${err.message}${err.path ? ` (${err.path})` : ""}`);
      }
    }
    if (result.conflicts?.length) {
      console.error("Import blocked by conflicts:");
      for (const conflict of result.conflicts) {
        console.error(
          `  - ${conflict.message}${conflict.path ? ` (${conflict.path})` : ""}`,
        );
      }
    }
    process.exit(1);
  }

  const summary = result.summary ?? {
    files_to_create: 0,
    files_to_overwrite: 0,
    files_unchanged: 0,
    total_files: 0,
  };
  console.log("Preflight analysis:");
  console.log(`  Files to create:    ${summary.files_to_create}`);
  console.log(`  Files to overwrite: ${summary.files_to_overwrite}`);
  console.log(`  Files unchanged:    ${summary.files_unchanged}`);
  console.log(`  Total:              ${summary.total_files}`);
  console.log("");

  const conflicts = result.conflicts ?? [];
  console.log(
    `Conflicts: ${conflicts.length > 0 ? conflicts.map((c) => c.message).join(", ") : "none"}`,
  );

  if (result.files && result.files.length > 0) {
    console.log("");
    console.log("Files:");
    for (const file of result.files) {
      console.log(`  [${file.action}] ${file.path}`);
    }
  }
}

function printImportSummary(result: ImportResponse): void {
  if (!result.success) {
    console.error(
      `Error: Import failed — ${result.message ?? result.reason ?? "unknown reason"}`,
    );
    for (const err of result.errors ?? []) {
      console.error(`  - ${err.message}${err.path ? ` (${err.path})` : ""}`);
    }
    process.exit(1);
  }

  const summary = result.summary ?? {
    total_files: 0,
    files_created: 0,
    files_overwritten: 0,
    files_skipped: 0,
    backups_created: 0,
  };
  console.log(`  Files created:     ${summary.files_created}`);
  console.log(`  Files overwritten: ${summary.files_overwritten}`);
  console.log(`  Files skipped:     ${summary.files_skipped}`);
  console.log(`  Backups created:   ${summary.backups_created}`);

  const creds = result.credentialsImported;
  if (creds) {
    console.log(`  Credentials imported: ${creds.succeeded}/${creds.total}`);
    if (creds.skippedPlatform) {
      console.log(`  Platform credentials skipped: ${creds.skippedPlatform}`);
    }
    if (creds.failed > 0) {
      console.log(`  Credentials failed:  ${creds.failed}`);
      for (const account of creds.failedAccounts) {
        console.log(`    - ${account}`);
      }
    }
  }

  const warnings = result.warnings ?? [];
  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`  ${warning}`);
    }
  }
}

/**
 * After teleporting to a local/docker target, register the assistant with
 * the platform and inject fresh platform credentials — mirroring the
 * login flow. Non-fatal: failures are logged as warnings.
 */
async function tryInjectPlatformCredentials(
  entry: AssistantEntry,
): Promise<void> {
  const token = readPlatformToken();
  if (!token) {
    console.log("  Skipped platform credential injection (not logged in).");
    return;
  }

  try {
    const user = await fetchCurrentUser(token);
    const orgId = await fetchOrganizationId(token);
    const clientInstallationId = computeDeviceId();
    const registration = await ensureSelfHostedLocalRegistration(
      token,
      orgId,
      clientInstallationId,
      entry.assistantId,
      "cli",
    );

    // Resolve the API key: 1) fresh from registration, 2) existing from
    // daemon credential store, 3) reprovision as last resort (revokes old key).
    // Only reprovision when the gateway confirms no key exists — not when
    // the gateway is merely unreachable (would revoke without injecting).
    let assistantApiKey = registration.assistant_api_key;
    if (!assistantApiKey) {
      const cached = await readGatewayCredential(
        entry.runtimeUrl,
        "vellum:assistant_api_key",
        entry.bearerToken,
      );
      if (cached.value) {
        assistantApiKey = cached.value;
      } else if (!cached.unreachable) {
        const reprovision = await reprovisionAssistantApiKey(
          token,
          orgId,
          clientInstallationId,
          entry.assistantId,
          "cli",
        );
        assistantApiKey = reprovision.provisioning.assistant_api_key;
      }
    }

    const allInjected = await injectCredentialsIntoAssistant({
      gatewayUrl: entry.runtimeUrl,
      bearerToken: entry.bearerToken,
      assistantApiKey,
      platformAssistantId: registration.assistant.id,
      platformBaseUrl: getPlatformUrl(),
      organizationId: orgId,
      userId: user.id,
      webhookSecret: registration.webhook_secret,
    });

    if (allInjected) {
      console.log("  Platform credentials injected.");
    } else {
      console.warn("  Some platform credentials could not be injected.");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Platform credential injection skipped: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function teleport(): Promise<void> {
  const args = process.argv.slice(3);
  const { from, to, targetEnv, targetName, keepSource, dryRun, help } =
    parseArgs(args);

  if (help) {
    printHelp();
    process.exit(0);
  }

  // Legacy --to flag deprecation
  if (to) {
    console.error("Error: --to is deprecated. Use environment flags instead:");
    console.error(
      "  vellum teleport --from <source> --local|--docker|--platform [name]",
    );
    console.error("");
    console.error("Run 'vellum teleport --help' for details.");
    process.exit(1);
  }

  if (!from) {
    printHelp();
    process.exit(1);
  }

  if (!targetEnv) {
    printHelp();
    process.exit(1);
  }

  // Look up source assistant
  const fromEntry = findAssistantByName(from);
  if (!fromEntry) {
    console.error(
      `Assistant '${from}' not found in lockfile. Run \`vellum ps\` to see available assistants.`,
    );
    process.exit(1);
  }

  const fromCloud = resolveCloud(fromEntry);

  if (fromCloud === "apple-container") {
    console.error(
      `Error: '${from}' uses the Apple Containers runtime. Teleport is not yet supported for this topology.`,
    );
    process.exit(1);
  }

  // Early same-environment guard — compare source cloud against the CLI flag
  // BEFORE exporting or hatching, to avoid creating orphaned assistants.
  const normalizedSourceEnv = fromCloud === "vellum" ? "platform" : fromCloud;
  if (normalizedSourceEnv === targetEnv) {
    console.error(
      `Cannot teleport between two ${targetEnv} assistants. Teleport transfers data across different environments.`,
    );
    process.exit(1);
  }

  // Dry-run without an existing target: skip export, hatch, and import —
  // just report what would happen.
  if (dryRun) {
    const existingTarget = targetName ? findAssistantByName(targetName) : null;

    if (existingTarget) {
      // Target exists — validate cloud matches the flag, then run preflight
      const toCloud = resolveCloud(existingTarget);
      const normalizedTargetEnv = toCloud === "vellum" ? "platform" : toCloud;
      if (normalizedTargetEnv !== targetEnv) {
        console.error(
          `Error: Assistant '${targetName}' is a ${normalizedTargetEnv} assistant, not ${targetEnv}. ` +
            `Use --${normalizedTargetEnv} to target it.`,
        );
        process.exit(1);
      }
      if (normalizedSourceEnv === normalizedTargetEnv) {
        console.error(
          `Cannot teleport between two ${normalizedTargetEnv} assistants. Teleport transfers data across different environments.`,
        );
        process.exit(1);
      }

      // Dry-run feasibility check — reject local/docker targets BEFORE any
      // export work. The local runtime has no preflight-from-gcs endpoint yet,
      // so we can't actually run a dry-run against it; burning a GCS upload
      // just to fail afterwards would be wasteful.
      // TODO(cli): support dry-run against local targets (needs a
      // preflight-from-gcs endpoint on the runtime).
      if (toCloud === "local" || toCloud === "docker") {
        console.error(
          "Error: --dry-run is not yet supported for local or docker targets (no preflight-from-gcs endpoint on the runtime).",
        );
        process.exit(1);
      }

      // Version guard: block platform→non-platform when target is behind
      if (fromCloud === "vellum" && toCloud !== "vellum") {
        const [sourceVersion, targetVersion] = await Promise.all([
          fetchCurrentVersion(fromEntry.runtimeUrl),
          fetchCurrentVersion(existingTarget.runtimeUrl),
        ]);
        const cmp =
          sourceVersion && targetVersion
            ? compareVersions(targetVersion, sourceVersion)
            : null;
        if (cmp !== null && cmp < 0) {
          console.error(
            `Error: Target assistant '${existingTarget.assistantId}' is running ${targetVersion}, ` +
              `but the platform source is on ${sourceVersion}.`,
          );
          console.error(
            `Upgrade your ${toCloud} assistant first: vellum upgrade ${existingTarget.assistantId}`,
          );
          process.exit(1);
        }
      }

      // Pin both upload and download to the same platform instance. For
      // platform targets the bundle is owned by the target platform; for
      // platform sources it's owned by the source platform. Only one of
      // these branches applies at a time (same-env was rejected earlier).
      const bundlePlatformUrl =
        toCloud === "vellum"
          ? existingTarget.runtimeUrl
          : fromCloud === "vellum"
            ? fromEntry.runtimeUrl
            : undefined;

      console.log(`Exporting from ${from} (${fromCloud})...`);
      const { bundleKey } = await exportFromAssistant(
        fromEntry,
        fromCloud,
        bundlePlatformUrl,
      );
      console.log(`Importing to ${existingTarget.assistantId} (${toCloud})...`);
      await importToAssistant(
        existingTarget,
        toCloud,
        bundleKey,
        true,
        bundlePlatformUrl,
      );
    } else {
      // No existing target — just describe what would happen
      console.log("Dry run summary:");
      console.log(`  Would export data from: ${from} (${fromCloud})`);
      console.log(`  Would upload bundle via signed URL`);
      console.log(
        `  Would hatch a new ${targetEnv} assistant${targetName ? ` named '${targetName}'` : ""}`,
      );
      console.log(`  Would import data into the new assistant`);
    }

    console.log(`Dry run complete — no changes were made.`);
    return;
  }

  // Platform target: reordered flow — upload to GCS before hatching so that
  // if export/upload fails, no empty assistant is left dangling on the platform.
  if (targetEnv === "platform") {
    const token = readPlatformToken();
    if (!token) {
      console.error("Not logged in. Run 'vellum login' first.");
      process.exit(1);
    }

    // If targeting an existing assistant, validate cloud match early — before
    // exporting — so we don't waste work on an invalid command.
    const existingTarget = targetName ? findAssistantByName(targetName) : null;
    if (existingTarget) {
      const existingCloud = resolveCloud(existingTarget);
      if (existingCloud !== "vellum") {
        console.error(
          `Error: Assistant '${targetName}' is a ${existingCloud} assistant, not platform. ` +
            `Use --${existingCloud} to target it.`,
        );
        process.exit(1);
      }
    }

    // Use the existing target's runtimeUrl for all platform calls so the
    // export, upload, and import all hit the same instance.
    const targetPlatformUrl = existingTarget?.runtimeUrl;

    // Pre-check: block if the user already has a platform assistant. This
    // runs BEFORE the expensive export so we don't waste the upload.
    if (!existingTarget) {
      const existing = await checkExistingPlatformAssistant(
        token,
        targetPlatformUrl,
      );
      if (existing) {
        saveAssistantEntry({
          assistantId: existing.id,
          runtimeUrl: getPlatformUrl(),
          cloud: "vellum",
          species: "vellum",
          hatchedAt: new Date().toISOString(),
        });
        console.error(
          `Error: You already have a platform assistant '${existing.id}'.`,
        );
        console.error(
          `Retire it first with 'vellum retire ${existing.id}', then retry the teleport.`,
        );
        process.exit(1);
      }
    }

    // Export — for local/docker sources this uploads straight into GCS via
    // the platform's signed URL; for platform sources this runs a server-side
    // export and we read the resulting bundle_key.
    // The signed upload URL must be requested from the same platform instance
    // where the import will run. For existing targets that's the lockfile's
    // runtimeUrl; for fresh hatches it's getPlatformUrl() (which is what
    // resolveOrHatchTarget writes to the new entry).
    console.log(`Exporting from ${from} (${fromCloud})...`);
    const bundlePlatformUrl = targetPlatformUrl ?? getPlatformUrl();
    const { bundleKey } = await exportFromAssistant(
      fromEntry,
      fromCloud,
      bundlePlatformUrl,
    );

    // Hatch (export succeeded — safe to create the target)
    const toEntry = await resolveOrHatchTarget(targetEnv, targetName);
    const toCloud = resolveCloud(toEntry);

    // Import from GCS
    console.log(`Importing to ${toEntry.assistantId} (${toCloud})...`);
    await importToAssistant(
      toEntry,
      toCloud,
      bundleKey,
      false,
      bundlePlatformUrl,
    );

    console.log(`Teleport complete: ${from} → ${toEntry.assistantId}`);
    return;
  }

  // Non-platform targets (local/docker)
  // For local<->docker transfers, stop (sleep) the source to free up ports
  // before hatching the target. We do NOT retire yet — if hatch or import
  // fails, the user can recover by running `vellum wake <source>`.
  const sourceIsLocalOrDocker = fromCloud === "local" || fromCloud === "docker";
  const targetIsLocalOrDocker = targetEnv === "local" || targetEnv === "docker";

  // Version guard (pre-hatch): for existing targets, check BEFORE hatching
  // to avoid creating orphaned assistants when the version check would fail.
  let versionGuardPassed = false;
  if (fromCloud === "vellum" && targetIsLocalOrDocker && targetName) {
    const existingTarget = findAssistantByName(targetName);
    if (existingTarget) {
      const [sourceVersion, existingVersion] = await Promise.all([
        fetchCurrentVersion(fromEntry.runtimeUrl),
        fetchCurrentVersion(existingTarget.runtimeUrl),
      ]);
      const cmp =
        sourceVersion && existingVersion
          ? compareVersions(existingVersion, sourceVersion)
          : null;
      if (cmp !== null && cmp < 0) {
        console.error(
          `Error: Target assistant '${existingTarget.assistantId}' is running ${existingVersion}, ` +
            `but the platform source is on ${sourceVersion}.`,
        );
        console.error(
          `Upgrade your ${targetEnv} assistant first: vellum upgrade ${existingTarget.assistantId}`,
        );
        process.exit(1);
      }
      // Pre-hatch check passed (or was best-effort skipped) — skip post-hatch
      versionGuardPassed = true;
    }
  }

  // Pin the bundle's platform instance so upload and download land on the
  // same GCS bucket. For platform sources the bundle is owned by the source
  // platform. For local/docker→local/docker the bundle lives on whatever
  // platform getPlatformUrl() currently resolves to — we resolve it once
  // here so a lockfile change mid-teleport can't split export and import.
  const bundlePlatformUrl =
    fromCloud === "vellum" ? fromEntry.runtimeUrl : getPlatformUrl();

  // Export from source (bundle lives in GCS after this returns).
  console.log(`Exporting from ${from} (${fromCloud})...`);
  const { bundleKey } = await exportFromAssistant(
    fromEntry,
    fromCloud,
    bundlePlatformUrl,
  );

  if (sourceIsLocalOrDocker && targetIsLocalOrDocker && !keepSource) {
    console.log(`Stopping source assistant '${from}' to free ports...`);
    if (fromCloud === "docker") {
      const res = dockerResourceNames(fromEntry.assistantId);
      await sleepContainers(res);
    } else if (fromEntry.resources) {
      const vellumDir = join(fromEntry.resources.instanceDir, ".vellum");
      const gatewayPidFile = join(vellumDir, "gateway.pid");
      await stopProcessByPidFile(
        getDaemonPidPath(fromEntry.resources),
        "assistant",
      );
      await stopProcessByPidFile(gatewayPidFile, "gateway", undefined, 7000);
    }
    console.log(`Source assistant '${from}' stopped.`);
  }

  // Resolve or hatch target (after source is stopped to avoid port conflicts)
  const toEntry = await resolveOrHatchTarget(targetEnv, targetName);
  const toCloud = resolveCloud(toEntry);

  // Post-hatch same-environment safety net — uses resolved clouds in case
  // the resolved target cloud differs from the CLI flag (e.g., --docker
  // targeting a name that is actually a local entry).
  const normalizedTargetEnv = toCloud === "vellum" ? "platform" : toCloud;
  if (normalizedSourceEnv === normalizedTargetEnv) {
    console.error(
      `Cannot teleport between two ${normalizedTargetEnv} assistants. Teleport transfers data across different environments.`,
    );
    process.exit(1);
  }

  // Version guard (post-hatch): for newly hatched targets we must check after
  // hatch because the assistant doesn't exist yet before. If it fails, clean
  // up the freshly hatched assistant to avoid orphans.
  // Skip if the pre-hatch guard already ran for an existing target.
  if (!versionGuardPassed && fromCloud === "vellum" && toCloud !== "vellum") {
    const [sourceVersion, targetVersion] = await Promise.all([
      fetchCurrentVersion(fromEntry.runtimeUrl),
      fetchCurrentVersion(toEntry.runtimeUrl),
    ]);
    const cmp =
      sourceVersion && targetVersion
        ? compareVersions(targetVersion, sourceVersion)
        : null;
    if (cmp !== null && cmp < 0) {
      // Clean up the freshly hatched assistant to avoid orphans
      console.error(
        `Cleaning up newly hatched assistant '${toEntry.assistantId}'...`,
      );
      if (toCloud === "docker") {
        await retireDocker(toEntry.assistantId);
      } else {
        await retireLocal(toEntry.assistantId, toEntry);
      }
      removeAssistantEntry(toEntry.assistantId);
      console.error(
        `Error: Target assistant '${toEntry.assistantId}' was running ${targetVersion}, ` +
          `but the platform source is on ${sourceVersion}.`,
      );
      console.error(
        `Upgrade your ${toCloud} environment first, then retry the teleport.`,
      );
      process.exit(1);
    }
  }

  // Import to target (also GCS-driven)
  console.log(`Importing to ${toEntry.assistantId} (${toCloud})...`);
  await importToAssistant(
    toEntry,
    toCloud,
    bundleKey,
    false,
    bundlePlatformUrl,
  );

  // After successful import, inject fresh platform credentials if the
  // user is logged in — replaces the source's stale vellum:* credentials
  // that were filtered during import.
  if (fromCloud === "vellum") {
    await tryInjectPlatformCredentials(toEntry);
  }

  // Retire source after successful import
  if (sourceIsLocalOrDocker && targetIsLocalOrDocker) {
    if (!keepSource) {
      console.log(`Retiring source assistant '${from}'...`);
      if (fromCloud === "docker") {
        await retireDocker(fromEntry.assistantId);
      } else {
        await retireLocal(fromEntry.assistantId, fromEntry);
      }
      removeAssistantEntry(fromEntry.assistantId);
      console.log(`Source assistant '${from}' retired.`);
    } else {
      console.log(`Source assistant '${from}' kept (--keep-source).`);
    }
  }

  console.log(`Teleport complete: ${from} → ${toEntry.assistantId}`);
}
