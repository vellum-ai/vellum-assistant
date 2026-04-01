import {
  findAssistantByName,
  loadAllAssistants,
  removeAssistantEntry,
  saveAssistantEntry,
  setActiveAssistant,
} from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  loadGuardianToken,
  leaseGuardianToken,
} from "../lib/guardian-token.js";
import {
  readPlatformToken,
  fetchOrganizationId,
  getPlatformUrl,
  hatchAssistant,
  platformInitiateExport,
  platformPollExportStatus,
  platformDownloadExport,
  platformImportPreflight,
  platformImportBundle,
  platformRequestUploadUrl,
  platformUploadToSignedUrl,
  platformImportPreflightFromGcs,
  platformImportBundleFromGcs,
} from "../lib/platform-client.js";
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
): Promise<string> {
  const tokenData = loadGuardianToken(assistantId);

  if (tokenData && new Date(tokenData.accessTokenExpiresAt) > new Date()) {
    return tokenData.accessToken;
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

// ---------------------------------------------------------------------------
// HTTP-based export/import helpers (shared by local and docker)
// ---------------------------------------------------------------------------

async function exportViaHttp(
  entry: AssistantEntry,
): Promise<Uint8Array<ArrayBuffer>> {
  let accessToken = await getAccessToken(
    entry.runtimeUrl,
    entry.assistantId,
    entry.assistantId,
  );

  let response: Response;
  try {
    response = await fetch(`${entry.runtimeUrl}/v1/migrations/export`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "teleport export" }),
      signal: AbortSignal.timeout(120_000),
    });

    // Retry once with a fresh token on 401
    if (response.status === 401) {
      let refreshedToken: string | null = null;
      try {
        const freshToken = await leaseGuardianToken(
          entry.runtimeUrl,
          entry.assistantId,
        );
        refreshedToken = freshToken.accessToken;
      } catch {
        // If token refresh fails, fall through to the error handler below
      }
      if (refreshedToken) {
        accessToken = refreshedToken;
        response = await fetch(`${entry.runtimeUrl}/v1/migrations/export`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ description: "teleport export" }),
          signal: AbortSignal.timeout(120_000),
        });
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("Error: Export request timed out after 2 minutes.");
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(
        `Error: Could not connect to assistant '${entry.assistantId}'. Is it running?`,
      );
      console.error(`Try: vellum wake ${entry.assistantId}`);
      process.exit(1);
    }
    throw err;
  }

  if (response.status === 401 || response.status === 403) {
    console.error("Authentication failed.");
    process.exit(1);
  }

  if (response.status === 404) {
    console.error("Assistant not found or not running.");
    process.exit(1);
  }

  if (
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  ) {
    console.error(
      `Assistant is unreachable. Try 'vellum wake ${entry.assistantId}'.`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(`Error: Export failed (${response.status}): ${body}`);
    process.exit(1);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

async function importViaHttp(
  entry: AssistantEntry,
  bundleData: Uint8Array<ArrayBuffer>,
  dryRun: boolean,
): Promise<void> {
  let accessToken = await getAccessToken(
    entry.runtimeUrl,
    entry.assistantId,
    entry.assistantId,
  );

  if (dryRun) {
    console.log("Running preflight analysis...\n");

    let response: Response;
    try {
      response = await fetch(
        `${entry.runtimeUrl}/v1/migrations/import-preflight`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/octet-stream",
          },
          body: new Blob([bundleData]),
          signal: AbortSignal.timeout(120_000),
        },
      );

      // Retry once with a fresh token on 401
      if (response.status === 401) {
        let refreshedToken: string | null = null;
        try {
          const freshToken = await leaseGuardianToken(
            entry.runtimeUrl,
            entry.assistantId,
          );
          refreshedToken = freshToken.accessToken;
        } catch {
          // If token refresh fails, fall through to the error handler below
        }
        if (refreshedToken) {
          accessToken = refreshedToken;
          response = await fetch(
            `${entry.runtimeUrl}/v1/migrations/import-preflight`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/octet-stream",
              },
              body: new Blob([bundleData]),
              signal: AbortSignal.timeout(120_000),
            },
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        console.error("Error: Preflight request timed out after 2 minutes.");
        process.exit(1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        console.error(
          `Error: Could not connect to assistant '${entry.assistantId}'. Is it running?`,
        );
        console.error(`Try: vellum wake ${entry.assistantId}`);
        process.exit(1);
      }
      throw err;
    }

    handleLocalResponseErrors(response, entry.assistantId);

    const result = (await response.json()) as PreflightResponse;
    printPreflightSummary(result);
    return;
  }

  // Actual import
  console.log("Importing data...");

  let response: Response;
  try {
    response = await fetch(`${entry.runtimeUrl}/v1/migrations/import`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Blob([bundleData]),
      signal: AbortSignal.timeout(120_000),
    });

    // Retry once with a fresh token on 401
    if (response.status === 401) {
      let refreshedToken: string | null = null;
      try {
        const freshToken = await leaseGuardianToken(
          entry.runtimeUrl,
          entry.assistantId,
        );
        refreshedToken = freshToken.accessToken;
      } catch {
        // If token refresh fails, fall through to the error handler below
      }
      if (refreshedToken) {
        accessToken = refreshedToken;
        response = await fetch(`${entry.runtimeUrl}/v1/migrations/import`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/octet-stream",
          },
          body: new Blob([bundleData]),
          signal: AbortSignal.timeout(120_000),
        });
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("Error: Import request timed out after 2 minutes.");
      process.exit(1);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      console.error(
        `Error: Could not connect to assistant '${entry.assistantId}'. Is it running?`,
      );
      console.error(`Try: vellum wake ${entry.assistantId}`);
      process.exit(1);
    }
    throw err;
  }

  handleLocalResponseErrors(response, entry.assistantId);

  const result = (await response.json()) as ImportResponse;
  printImportSummary(result);
}

// ---------------------------------------------------------------------------
// Export from source assistant
// ---------------------------------------------------------------------------

async function exportFromAssistant(
  entry: AssistantEntry,
  cloud: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (cloud === "vellum") {
    // Platform source — use Django async export
    const token = readPlatformToken();
    if (!token) {
      console.error("Not logged in. Run 'vellum login' first.");
      process.exit(1);
    }

    let orgId: string;
    try {
      orgId = await fetchOrganizationId(token, entry.runtimeUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403")) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }
      throw err;
    }

    // Initiate export job
    let jobId: string;
    try {
      const result = await platformInitiateExport(
        token,
        orgId,
        "teleport export",
        entry.runtimeUrl,
      );
      jobId = result.jobId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403")) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }
      throw err;
    }

    console.log(`Export started (job ${jobId})...`);

    // Poll for completion
    const POLL_INTERVAL_MS = 2_000;
    const TIMEOUT_MS = 5 * 60 * 1_000;
    const deadline = Date.now() + TIMEOUT_MS;
    let downloadUrl: string | undefined;

    while (Date.now() < deadline) {
      let status: { status: string; downloadUrl?: string; error?: string };
      try {
        status = await platformPollExportStatus(
          jobId,
          token,
          orgId,
          entry.runtimeUrl,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          throw err;
        }
        console.warn(`Polling failed, retrying... (${msg})`);
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      if (status.status === "complete") {
        downloadUrl = status.downloadUrl;
        break;
      }

      if (status.status === "failed") {
        console.error(`Export failed: ${status.error ?? "unknown error"}`);
        process.exit(1);
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!downloadUrl) {
      console.error("Export timed out after 5 minutes.");
      process.exit(1);
    }

    // Download the bundle
    const response = await platformDownloadExport(downloadUrl);
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  if (cloud === "local" || cloud === "docker") {
    return exportViaHttp(entry);
  }

  console.error(
    "Teleport only supports local, docker, and platform assistants as source.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Import into target assistant
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
}

async function importToAssistant(
  entry: AssistantEntry,
  cloud: string,
  bundleData: Uint8Array<ArrayBuffer>,
  dryRun: boolean,
  preUploadedBundleKey?: string | null,
): Promise<void> {
  if (cloud === "vellum") {
    // Platform target
    const token = readPlatformToken();
    if (!token) {
      console.error("Not logged in. Run 'vellum login' first.");
      process.exit(1);
    }

    let orgId: string;
    try {
      orgId = await fetchOrganizationId(token, entry.runtimeUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403")) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }
      throw err;
    }

    // Use pre-uploaded bundle key if provided (string), skip upload if null
    // (signals signed URLs were already tried and unavailable), or try
    // signed-URL upload if undefined (never attempted).
    let bundleKey: string | undefined =
      preUploadedBundleKey === null ? undefined : preUploadedBundleKey;
    if (preUploadedBundleKey === undefined) {
      try {
        const { uploadUrl, bundleKey: key } = await platformRequestUploadUrl(
          token,
          orgId,
          entry.runtimeUrl,
        );
        bundleKey = key;
        console.log("Uploading bundle...");
        await platformUploadToSignedUrl(uploadUrl, bundleData);
      } catch (err) {
        // If signed uploads unavailable (503), fall back to inline upload
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not available")) {
          bundleKey = undefined;
        } else {
          throw err;
        }
      }
    }

    if (dryRun) {
      console.log("Running preflight analysis...\n");

      let preflightResult: {
        statusCode: number;
        body: Record<string, unknown>;
      };
      try {
        preflightResult = bundleKey
          ? await platformImportPreflightFromGcs(
              bundleKey,
              token,
              orgId,
              entry.runtimeUrl,
            )
          : await platformImportPreflight(
              bundleData,
              token,
              orgId,
              entry.runtimeUrl,
            );
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          console.error("Error: Preflight request timed out after 2 minutes.");
          process.exit(1);
        }
        throw err;
      }

      if (
        preflightResult.statusCode === 401 ||
        preflightResult.statusCode === 403
      ) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }

      if (preflightResult.statusCode === 404) {
        console.error("Assistant not found or not running.");
        process.exit(1);
      }

      if (
        preflightResult.statusCode === 502 ||
        preflightResult.statusCode === 503 ||
        preflightResult.statusCode === 504
      ) {
        console.error(
          `Assistant is unreachable. Try 'vellum wake ${entry.assistantId}'.`,
        );
        process.exit(1);
      }

      if (preflightResult.statusCode !== 200) {
        console.error(
          `Error: Preflight check failed (${preflightResult.statusCode}): ${JSON.stringify(preflightResult.body)}`,
        );
        process.exit(1);
      }

      const result = preflightResult.body as unknown as PreflightResponse;
      printPreflightSummary(result);
      return;
    }

    // Actual import
    console.log("Importing data...");

    let importResult: { statusCode: number; body: Record<string, unknown> };
    try {
      importResult = bundleKey
        ? await platformImportBundleFromGcs(
            bundleKey,
            token,
            orgId,
            entry.runtimeUrl,
          )
        : await platformImportBundle(
            bundleData,
            token,
            orgId,
            entry.runtimeUrl,
          );
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        console.error("Error: Import request timed out after 2 minutes.");
        process.exit(1);
      }
      throw err;
    }

    handleImportStatusErrors(importResult.statusCode, entry.assistantId);

    const result = importResult.body as unknown as ImportResponse;
    printImportSummary(result);
    return;
  }

  if (cloud === "local" || cloud === "docker") {
    await importViaHttp(entry, bundleData, dryRun);
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
  orgId?: string,
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
    await hatchLocal("vellum", targetName ?? null, false, false, false, {});
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

    let resolvedOrgId: string;
    if (orgId) {
      resolvedOrgId = orgId;
    } else {
      try {
        resolvedOrgId = await fetchOrganizationId(token);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401") || msg.includes("403")) {
          console.error(
            "Authentication failed. Run 'vellum login' to refresh.",
          );
          process.exit(1);
        }
        throw err;
      }
    }

    const result = await hatchAssistant(token, resolvedOrgId);
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
// Error handling helpers
// ---------------------------------------------------------------------------

function handleLocalResponseErrors(
  response: Response,
  assistantName: string,
): void {
  if (response.status === 401 || response.status === 403) {
    console.error("Authentication failed.");
    process.exit(1);
  }

  if (response.status === 404) {
    console.error("Assistant not found or not running.");
    process.exit(1);
  }

  if (
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  ) {
    console.error(
      `Assistant is unreachable. Try 'vellum wake ${assistantName}'.`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`Error: Request failed (${response.status})`);
    process.exit(1);
  }
}

function handleImportStatusErrors(
  statusCode: number,
  assistantName: string,
): void {
  if (statusCode === 401 || statusCode === 403) {
    console.error("Authentication failed. Run 'vellum login' to refresh.");
    process.exit(1);
  }

  if (statusCode === 404) {
    console.error("Assistant not found or not running.");
    process.exit(1);
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    console.error(
      `Assistant is unreachable. Try 'vellum wake ${assistantName}'.`,
    );
    process.exit(1);
  }

  if (statusCode < 200 || statusCode >= 300) {
    console.error(`Error: Import failed (${statusCode})`);
    process.exit(1);
  }
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

  const warnings = result.warnings ?? [];
  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`  ${warning}`);
    }
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

      console.log(`Exporting from ${from} (${fromCloud})...`);
      const bundleData = await exportFromAssistant(fromEntry, fromCloud);
      console.log(`Importing to ${existingTarget.assistantId} (${toCloud})...`);
      await importToAssistant(existingTarget, toCloud, bundleData, true);
    } else {
      // No existing target — just describe what would happen
      console.log("Dry run summary:");
      console.log(`  Would export data from: ${from} (${fromCloud})`);
      if (targetEnv === "platform") {
        // For platform targets, reflect the reordered flow
        console.log(`  Would upload bundle via signed URL (if available)`);
        console.log(
          `  Would hatch a new ${targetEnv} assistant${targetName ? ` named '${targetName}'` : ""}`,
        );
        console.log(`  Would import data into the new assistant`);
      } else {
        console.log(
          `  Would hatch a new ${targetEnv} assistant${targetName ? ` named '${targetName}'` : ""}`,
        );
        console.log(`  Would import data into the new assistant`);
      }
    }

    console.log(`Dry run complete — no changes were made.`);
    return;
  }

  // Export from source
  console.log(`Exporting from ${from} (${fromCloud})...`);
  const bundleData = await exportFromAssistant(fromEntry, fromCloud);

  // Platform target: reordered flow — upload to GCS before hatching so that
  // if upload fails, no empty assistant is left dangling on the platform.
  if (targetEnv === "platform") {
    // Step B — Auth + Org ID
    const token = readPlatformToken();
    if (!token) {
      console.error("Not logged in. Run 'vellum login' first.");
      process.exit(1);
    }

    // If targeting an existing assistant, validate cloud match early — before
    // uploading — so we don't waste a GCS upload on an invalid command.
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

    // Use the existing target's runtimeUrl for all platform calls so upload,
    // org ID fetch, and import hit the same instance.
    const targetPlatformUrl = existingTarget?.runtimeUrl;

    let orgId: string;
    try {
      orgId = await fetchOrganizationId(token, targetPlatformUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403")) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }
      throw err;
    }

    // Step C — Upload to GCS
    // bundleKey: string = uploaded successfully, null = tried but unavailable,
    // undefined would mean "never tried" (not used here).
    let bundleKey: string | null = null;
    try {
      const { uploadUrl, bundleKey: key } = await platformRequestUploadUrl(
        token,
        orgId,
        targetPlatformUrl,
      );
      bundleKey = key;
      console.log("Uploading bundle to GCS...");
      await platformUploadToSignedUrl(uploadUrl, bundleData);
    } catch (err) {
      // If signed uploads unavailable (503), fall back to inline upload later
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not available")) {
        bundleKey = null;
      } else {
        throw err;
      }
    }

    // Step D — Hatch (upload succeeded or fallback to inline — safe to hatch)
    const toEntry = await resolveOrHatchTarget(targetEnv, targetName, orgId);
    const toCloud = resolveCloud(toEntry);

    // Step E — Import from GCS (or inline fallback)
    // Pass bundleKey (string) or null to signal "already tried, use inline".
    console.log(`Importing to ${toEntry.assistantId} (${toCloud})...`);
    await importToAssistant(toEntry, toCloud, bundleData, false, bundleKey);

    // Success summary
    console.log(`Teleport complete: ${from} → ${toEntry.assistantId}`);
    return;
  }

  // Non-platform targets (local/docker): existing flow unchanged
  // For local<->docker transfers, stop (sleep) the source to free up ports
  // before hatching the target. We do NOT retire yet — if hatch or import
  // fails, the user can recover by running `vellum wake <source>`.
  const sourceIsLocalOrDocker = fromCloud === "local" || fromCloud === "docker";
  const targetIsLocalOrDocker = targetEnv === "local" || targetEnv === "docker";
  if (sourceIsLocalOrDocker && targetIsLocalOrDocker && !keepSource) {
    console.log(`Stopping source assistant '${from}' to free ports...`);
    if (fromCloud === "docker") {
      const res = dockerResourceNames(fromEntry.assistantId);
      await sleepContainers(res);
    } else if (fromEntry.resources) {
      const pidFile = fromEntry.resources.pidFile;
      const vellumDir = join(fromEntry.resources.instanceDir, ".vellum");
      const gatewayPidFile = join(vellumDir, "gateway.pid");
      await stopProcessByPidFile(pidFile, "assistant");
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

  // Import to target
  console.log(`Importing to ${toEntry.assistantId} (${toCloud})...`);
  await importToAssistant(toEntry, toCloud, bundleData, false);

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

  // Success summary
  console.log(`Teleport complete: ${from} → ${toEntry.assistantId}`);
}
