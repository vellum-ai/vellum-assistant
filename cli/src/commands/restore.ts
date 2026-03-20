import { existsSync, readFileSync } from "fs";

import { findAssistantByName } from "../lib/assistant-config.js";
import {
  loadGuardianToken,
  leaseGuardianToken,
} from "../lib/guardian-token.js";

function printUsage(): void {
  console.log("Usage: vellum restore <name> --from <path> [--dry-run]");
  console.log("");
  console.log("Restore a .vbundle backup into a running assistant.");
  console.log("");
  console.log("Arguments:");
  console.log("  <name>              Name of the assistant to restore into");
  console.log("");
  console.log("Options:");
  console.log(
    "  --from <path>       Path to the .vbundle file to restore (required)",
  );
  console.log("  --dry-run           Show what would change without applying");
  console.log("");
  console.log("Examples:");
  console.log("  vellum restore my-assistant --from ~/Desktop/backup.vbundle");
  console.log(
    "  vellum restore my-assistant --from ~/Desktop/backup.vbundle --dry-run",
  );
}

function parseArgs(argv: string[]): {
  name: string | undefined;
  fromPath: string | undefined;
  dryRun: boolean;
  help: boolean;
} {
  const args = argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    return { name: undefined, fromPath: undefined, dryRun: false, help: true };
  }

  let fromPath: string | undefined;
  const dryRun = args.includes("--dry-run");
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      fromPath = args[i + 1];
      i++; // skip the value
    } else if (args[i] === "--dry-run") {
      // already handled above
    } else if (!args[i].startsWith("-")) {
      positionals.push(args[i]);
    }
  }

  return { name: positionals[0], fromPath, dryRun, help: false };
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

export async function restore(): Promise<void> {
  const { name, fromPath, dryRun, help } = parseArgs(process.argv);

  if (help) {
    printUsage();
    process.exit(0);
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

  // Obtain auth token
  const accessToken = await getAccessToken(
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
          console.error(`  - ${err.message}${err.path ? ` (${err.path})` : ""}`);
        }
      }
      if (result.conflicts?.length) {
        console.error("Import blocked by conflicts:");
        for (const conflict of result.conflicts) {
          console.error(`  - ${conflict.message}${conflict.path ? ` (${conflict.path})` : ""}`);
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
    // Full import
    console.log("Importing backup...\n");

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
