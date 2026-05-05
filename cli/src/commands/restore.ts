import { existsSync, readFileSync } from "fs";

import { findAssistantByName } from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  loadGuardianToken,
  leaseGuardianToken,
} from "../lib/guardian-token.js";
import {
  readPlatformToken,
  rollbackPlatformAssistant,
  platformRequestSignedUrl,
  platformUploadToSignedUrl,
  platformImportPreflightFromGcs,
  platformImportBundleFromGcs,
  platformPollJobStatus,
} from "../lib/platform-client.js";
import { performDockerRollback } from "../lib/upgrade-lifecycle.js";

function printUsage(): void {
  console.log(
    "Usage: vellum restore <name> --from <path> [--version <version>] [--dry-run]",
  );
  console.log("");
  console.log("Restore data from a .vbundle backup into an assistant.");
  console.log(
    "With --version, also rolls back to the specified version first.",
  );
  console.log("");
  console.log("Arguments:");
  console.log("  <name>               Name of the assistant to restore into");
  console.log("");
  console.log("Options:");
  console.log("  --from <path>        Path to the .vbundle file (required)");
  console.log(
    "  --version <version>  Roll back to this version before importing data",
  );
  console.log(
    "  --dry-run            Show what would change without applying (data-only)",
  );
  console.log("");
  console.log("Examples:");
  console.log("  vellum restore my-assistant --from backup.vbundle");
  console.log(
    "  vellum restore my-assistant --from backup.vbundle --version v1.2.3",
  );
  console.log("  vellum restore my-assistant --from backup.vbundle --dry-run");
}

function parseArgs(argv: string[]): {
  name: string | undefined;
  fromPath: string | undefined;
  version: string | undefined;
  dryRun: boolean;
  help: boolean;
} {
  const args = argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    return {
      name: undefined,
      fromPath: undefined,
      version: undefined,
      dryRun: false,
      help: true,
    };
  }

  let fromPath: string | undefined;
  let version: string | undefined;
  const dryRun = args.includes("--dry-run");
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      fromPath = args[i + 1];
      i++; // skip the value
    } else if (args[i] === "--version") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --version requires a value");
        process.exit(1);
      }
      version = next;
      i++; // skip the value
    } else if (args[i] === "--dry-run") {
      // already handled above
    } else if (!args[i].startsWith("-")) {
      positionals.push(args[i]);
    }
  }

  return { name: positionals[0], fromPath, version, dryRun, help: false };
}

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

// ---------------------------------------------------------------------------
// Platform (Vellum-hosted) restore via Django migration import
// ---------------------------------------------------------------------------

async function restorePlatform(
  entry: AssistantEntry,
  name: string,
  bundleData: Buffer,
  opts: { version?: string; dryRun: boolean },
): Promise<void> {
  // Step 1 — Authenticate
  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run 'vellum login' first.");
    process.exit(1);
  }

  // Step 1.5 — Upload to GCS via signed URL.
  // We deliberately omit min/max runtime version here: restore uploads an
  // arbitrary .vbundle from disk (often produced by a different runtime
  // than the one we'd query right now), and the bundle's own manifest is
  // the authority on its compatibility band. The platform skips the
  // version gate when these fields are absent and re-derives compat from
  // the manifest when it processes the import.
  const { url: uploadUrl, bundleKey } = await platformRequestSignedUrl(
    { operation: "upload" },
    token,
    entry.runtimeUrl,
  );
  console.log("Uploading bundle...");
  await platformUploadToSignedUrl(uploadUrl, new Uint8Array(bundleData));

  // Step 2 — Dry-run path
  if (opts.dryRun) {
    if (opts.version) {
      console.error(
        "Dry-run is not supported with --version. Use `vellum restore --from <path> --dry-run` for data-only preflight.",
      );
      process.exit(1);
    }

    console.log("Running preflight analysis...\n");

    let preflightResult: { statusCode: number; body: Record<string, unknown> };
    try {
      preflightResult = await platformImportPreflightFromGcs(
        bundleKey,
        token,
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
      console.error(
        "No managed assistant found. Ensure your assistant is running.",
      );
      process.exit(1);
    }

    if (preflightResult.statusCode === 409) {
      console.error(
        "Multiple assistants found. This is a platform configuration issue.",
      );
      process.exit(1);
    }

    if (
      preflightResult.statusCode === 502 ||
      preflightResult.statusCode === 503 ||
      preflightResult.statusCode === 504
    ) {
      console.error(
        `Assistant is unreachable. Try 'vellum wake ${name}' first.`,
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

    if (!result.can_import) {
      if (result.validation?.errors?.length) {
        console.error("Import blocked by validation errors:");
        for (const err of result.validation.errors) {
          console.error(
            `  - ${err.message}${err.path ? ` (${err.path})` : ""}`,
          );
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

    // Print summary table
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

    // List individual files with their action
    if (result.files && result.files.length > 0) {
      console.log("");
      console.log("Files:");
      for (const file of result.files) {
        console.log(`  [${file.action}] ${file.path}`);
      }
    }

    return;
  }

  // Step 3 — Version rollback (if --version set)
  if (opts.version) {
    console.log(
      `Rolling back to version ${opts.version} before restoring data...`,
    );

    try {
      await rollbackPlatformAssistant(token, opts.version, entry.runtimeUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("401") || msg.includes("403")) {
        console.error("Authentication failed. Run 'vellum login' to refresh.");
        process.exit(1);
      }
      console.error(`Error: Rollback failed — ${msg}`);
      process.exit(1);
    }

    console.log(
      `Rolled back to ${opts.version}. Proceeding with data restore...`,
    );
  }

  // Step 4 — Data import
  console.log("Importing backup data...");

  let importResult: { statusCode: number; body: Record<string, unknown> };
  try {
    importResult = await platformImportBundleFromGcs(
      bundleKey,
      token,
      entry.runtimeUrl,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("Error: Import request timed out after 5 minutes.");
      process.exit(1);
    }
    throw err;
  }

  if (importResult.statusCode === 401 || importResult.statusCode === 403) {
    console.error("Authentication failed. Run 'vellum login' to refresh.");
    process.exit(1);
  }

  if (importResult.statusCode === 404) {
    console.error(
      "No managed assistant found. Ensure your assistant is running.",
    );
    process.exit(1);
  }

  if (importResult.statusCode === 409) {
    console.error(
      "Multiple assistants found. This is a platform configuration issue.",
    );
    process.exit(1);
  }

  if (
    importResult.statusCode === 502 ||
    importResult.statusCode === 503 ||
    importResult.statusCode === 504
  ) {
    console.error(`Assistant is unreachable. Try 'vellum wake ${name}' first.`);
    process.exit(1);
  }

  if (
    importResult.statusCode !== 202 &&
    (importResult.statusCode < 200 || importResult.statusCode >= 300)
  ) {
    console.error(`Error: Import failed (${importResult.statusCode})`);
    process.exit(1);
  }

  // Async import — poll until complete
  if (importResult.statusCode === 202) {
    const jobId = (importResult.body as { job_id?: string }).job_id;
    if (!jobId) {
      console.error("Error: Import accepted but no job ID returned.");
      process.exit(1);
    }

    const POLL_INTERVAL_MS = 5_000;
    const TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes
    const startTime = Date.now();
    const deadline = startTime + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      let status: Awaited<ReturnType<typeof platformPollJobStatus>>;
      try {
        status = await platformPollJobStatus(jobId, token, entry.runtimeUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          throw err;
        }
        // Fail fast on auth errors from authHeaders() which don't
        // match the "status check failed: NNN" format
        if (msg.includes("401") || msg.includes("403")) {
          throw err;
        }
        // Re-throw permanent 4xx errors, retry transient 5xx
        const statusMatch = msg.match(/status check failed: (\d+)/);
        if (statusMatch) {
          const statusCode = parseInt(statusMatch[1], 10);
          if (statusCode >= 400 && statusCode < 500) {
            throw err;
          }
        }
        // Transient error (5xx, network) — retry
        console.warn(`Polling failed, retrying... (${msg})`);
        continue;
      }

      if (status.status === "complete") {
        importResult = {
          statusCode: 200,
          body: (status.result as Record<string, unknown>) ?? {},
        };
        break;
      }

      if (status.status === "failed") {
        console.error(`Import failed: ${status.error ?? "unknown error"}`);
        process.exit(1);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\rImporting... ${elapsed}s elapsed`);
    }

    // Clear the progress line
    process.stdout.write("\r" + " ".repeat(40) + "\r");

    if (importResult.statusCode === 202) {
      console.error("Import timed out after 10 minutes.");
      process.exit(1);
    }
  }

  const result = importResult.body as unknown as ImportResponse;

  if (!result.success) {
    console.error(
      `Error: Import failed — ${result.message ?? result.reason ?? "unknown reason"}`,
    );
    for (const err of result.errors ?? []) {
      console.error(`  - ${err.message}${err.path ? ` (${err.path})` : ""}`);
    }
    process.exit(1);
  }

  // Print import report
  const summary = result.summary ?? {
    total_files: 0,
    files_created: 0,
    files_overwritten: 0,
    files_skipped: 0,
    backups_created: 0,
  };
  console.log("✅ Restore complete.");
  console.log(`  Files created:     ${summary.files_created}`);
  console.log(`  Files overwritten: ${summary.files_overwritten}`);
  console.log(`  Files skipped:     ${summary.files_skipped}`);
  console.log(`  Backups created:   ${summary.backups_created}`);

  // Print warnings if any
  const warnings = result.warnings ?? [];
  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`  ⚠️  ${warning}`);
    }
  }
}

export async function restore(): Promise<void> {
  const { name, fromPath, version, dryRun, help } = parseArgs(process.argv);

  if (help) {
    printUsage();
    process.exit(0);
  }

  // --version requires --from
  if (version && !fromPath) {
    console.error(
      "A backup file is required for restore. Use --from <path> to specify the .vbundle file.",
    );
    process.exit(1);
  }

  // --dry-run is not supported with --version
  if (version && dryRun) {
    console.error(
      "Dry-run is not supported with --version. Use `vellum restore --from <path> --dry-run` for data-only preflight.",
    );
    process.exit(1);
  }

  if (!name || !fromPath) {
    console.error("Error: Both <name> and --from <path> are required.");
    console.error("");
    printUsage();
    process.exit(1);
  }

  // Look up the instance
  const entry = findAssistantByName(name);
  if (!entry) {
    console.error(`Error: No assistant found with name '${name}'.`);
    console.error("Run 'vellum ps' to see available assistants.");
    process.exit(1);
  }

  // Verify .vbundle file exists
  if (!existsSync(fromPath)) {
    console.error(`Error: File not found: ${fromPath}`);
    process.exit(1);
  }

  // Read the .vbundle file
  const bundleData = readFileSync(fromPath);
  const sizeMB = (bundleData.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`Reading ${fromPath} (${sizeMB} MB)...`);

  // Detect topology and route platform assistants through Django import
  const cloud =
    entry.cloud || (entry.project ? "gcp" : entry.sshUser ? "custom" : "local");

  if (cloud === "apple-container") {
    console.error(
      `Error: '${name}' uses the Apple Containers runtime. Restore is not yet supported for this topology.`,
    );
    process.exit(1);
  }

  if (cloud === "vellum") {
    await restorePlatform(entry, name, bundleData, { version, dryRun });
    return;
  }

  if (version && cloud !== "docker") {
    console.error(
      "Restore with --version is only supported for Docker and managed assistants.",
    );
    process.exit(1);
  }

  // Obtain auth token (acquired before dry-run or before data import;
  // re-acquired after version rollback since containers restart).
  let accessToken = await getAccessToken(
    entry.runtimeUrl,
    entry.assistantId,
    name,
  );

  if (dryRun) {
    // Preflight check
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
          body: bundleData,
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
          `Error: Could not connect to assistant '${name}'. Is it running?`,
        );
        console.error(`Try: vellum wake ${name}`);
        process.exit(1);
      }
      throw err;
    }

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `Error: Preflight check failed (${response.status}): ${body}`,
      );
      process.exit(1);
    }

    const result = (await response.json()) as PreflightResponse;

    if (!result.can_import) {
      if (result.validation?.errors?.length) {
        console.error("Import blocked by validation errors:");
        for (const err of result.validation.errors) {
          console.error(
            `  - ${err.message}${err.path ? ` (${err.path})` : ""}`,
          );
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

    // Print summary table
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

    // List individual files with their action
    if (result.files && result.files.length > 0) {
      console.log("");
      console.log("Files:");
      for (const file of result.files) {
        console.log(`  [${file.action}] ${file.path}`);
      }
    }
  } else {
    // Version rollback (when --version is specified)
    if (version) {
      console.log(`Rolling back to version ${version}...`);
      await performDockerRollback(entry, { targetVersion: version });
      console.log("");

      // Re-acquire auth token since containers were restarted during rollback
      accessToken = await getAccessToken(
        entry.runtimeUrl,
        entry.assistantId,
        name,
      );
    }

    // Data import
    console.log("Importing backup data...\n");

    let response: Response;
    try {
      response = await fetch(`${entry.runtimeUrl}/v1/migrations/import`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: bundleData,
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
          `Error: Could not connect to assistant '${name}'. Is it running?`,
        );
        console.error(`Try: vellum wake ${name}`);
        process.exit(1);
      }
      throw err;
    }

    if (!response.ok) {
      const body = await response.text();
      console.error(`Error: Import failed (${response.status}): ${body}`);
      process.exit(1);
    }

    const result = (await response.json()) as ImportResponse;

    if (!result.success) {
      console.error(
        `Error: Import failed — ${result.message ?? result.reason ?? "unknown reason"}`,
      );
      for (const err of result.errors ?? []) {
        console.error(`  - ${err.message}${err.path ? ` (${err.path})` : ""}`);
      }
      process.exit(1);
    }

    // Print import report
    const summary = result.summary ?? {
      total_files: 0,
      files_created: 0,
      files_overwritten: 0,
      files_skipped: 0,
      backups_created: 0,
    };
    console.log("✅ Restore complete.");
    console.log(`  Files created:     ${summary.files_created}`);
    console.log(`  Files overwritten: ${summary.files_overwritten}`);
    console.log(`  Files skipped:     ${summary.files_skipped}`);
    console.log(`  Backups created:   ${summary.backups_created}`);

    // Print warnings if any
    const warnings = result.warnings ?? [];
    if (warnings.length > 0) {
      console.log("");
      console.log("Warnings:");
      for (const warning of warnings) {
        console.log(`  ⚠️  ${warning}`);
      }
    }
  }
}
