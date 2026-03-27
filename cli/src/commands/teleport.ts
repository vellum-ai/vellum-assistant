import { findAssistantByName } from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  loadGuardianToken,
  leaseGuardianToken,
} from "../lib/guardian-token.js";
import {
  readPlatformToken,
  fetchOrganizationId,
  platformInitiateExport,
  platformPollExportStatus,
  platformDownloadExport,
  platformImportPreflight,
  platformImportBundle,
} from "../lib/platform-client.js";

function printHelp(): void {
  console.log(
    "Usage: vellum teleport --from <assistant> --to <assistant> [options]",
  );
  console.log("");
  console.log(
    "Transfer assistant data between local and platform environments.",
  );
  console.log("");
  console.log("Options:");
  console.log("  --from <name>   Source assistant to export data from");
  console.log("  --to <name>     Target assistant to import data into");
  console.log(
    "  --dry-run       Preview the transfer without applying changes",
  );
  console.log("  --help, -h      Show this help");
  console.log("");
  console.log("Examples:");
  console.log("  vellum teleport --from my-local --to my-cloud");
  console.log("  vellum teleport --from my-cloud --to my-local --dry-run");
  console.log("  vellum teleport --from staging --to production --dry-run");
}

function parseArgs(argv: string[]): {
  from: string | undefined;
  to: string | undefined;
  dryRun: boolean;
  help: boolean;
} {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  let help = false;

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
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { from, to, dryRun, help };
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

  if (cloud === "local") {
    // Local source — direct export endpoint
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

  console.error(
    "Teleport only supports local and platform assistants as source.",
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

    if (dryRun) {
      console.log("Running preflight analysis...\n");

      let preflightResult: {
        statusCode: number;
        body: Record<string, unknown>;
      };
      try {
        preflightResult = await platformImportPreflight(
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
      importResult = await platformImportBundle(
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

  if (cloud === "local") {
    // Local target
    const accessToken = await getAccessToken(
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
    return;
  }

  console.error(
    "Teleport only supports local and platform assistants as target.",
  );
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
  const { from, to, dryRun, help } = parseArgs(args);

  if (help) {
    printHelp();
    process.exit(0);
  }

  if (!from || !to) {
    printHelp();
    process.exit(1);
  }

  // Look up both assistants
  const fromEntry = findAssistantByName(from);
  if (!fromEntry) {
    console.error(
      `Assistant '${from}' not found in lockfile. Run \`vellum ps\` to see available assistants.`,
    );
    process.exit(1);
  }

  const toEntry = findAssistantByName(to);
  if (!toEntry) {
    console.error(
      `Assistant '${to}' not found in lockfile. Run \`vellum ps\` to see available assistants.`,
    );
    process.exit(1);
  }

  const fromCloud = resolveCloud(fromEntry);
  const toCloud = resolveCloud(toEntry);

  // Export from source
  console.log(`Exporting from ${from} (${fromCloud})...`);
  const bundleData = await exportFromAssistant(fromEntry, fromCloud);

  // Import to target
  console.log(`Importing to ${to} (${toCloud})...`);
  await importToAssistant(toEntry, toCloud, bundleData, dryRun);

  // Success summary
  console.log(`Teleport complete: ${from} → ${to}`);
}
