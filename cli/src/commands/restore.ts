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
  console.log(
    "  --dry-run           Show what would change without applying",
  );
  console.log("");
  console.log("Examples:");
  console.log(
    "  vellum restore my-assistant --from ~/Desktop/backup.vbundle",
  );
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
): Promise<string> {
  const tokenData = loadGuardianToken(assistantId);

  if (
    tokenData &&
    new Date(tokenData.accessTokenExpiresAt) > new Date()
  ) {
    return tokenData.accessToken;
  }

  const freshToken = await leaseGuardianToken(runtimeUrl, assistantId);
  return freshToken.accessToken;
}

interface PreflightFileEntry {
  path: string;
  action: string;
}

interface PreflightResponse {
  can_import: boolean;
  errors?: string[];
  files?: PreflightFileEntry[];
  summary?: {
    create: number;
    overwrite: number;
    unchanged: number;
    total: number;
  };
  conflicts?: string[];
}

interface ImportResponse {
  success: boolean;
  reason?: string;
  errors?: string[];
  warnings?: string[];
  summary?: {
    created: number;
    overwritten: number;
    skipped: number;
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
    console.error(
      "Error: Both <name> and --from <path> are required.",
    );
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
  const bundleData = readFileSync(fromPath) as unknown as Uint8Array;
  const sizeMB = (bundleData.byteLength / (1024 * 1024)).toFixed(2);
  console.log(`Reading ${fromPath} (${sizeMB} MB)...`);

  // Obtain auth token
  const accessToken = await getAccessToken(entry.runtimeUrl, name);

  if (dryRun) {
    // Preflight check
    console.log("Running preflight analysis...\n");

    const response = await fetch(
      `${entry.runtimeUrl}/v1/migrations/import-preflight`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        body: bundleData,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `Error: Preflight check failed (${response.status}): ${body}`,
      );
      process.exit(1);
    }

    const result = (await response.json()) as PreflightResponse;

    if (!result.can_import) {
      console.error("Import blocked by validation errors:");
      for (const err of result.errors ?? []) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    // Print summary table
    const summary = result.summary ?? {
      create: 0,
      overwrite: 0,
      unchanged: 0,
      total: 0,
    };
    console.log("Preflight analysis:");
    console.log(`  Files to create:    ${summary.create}`);
    console.log(`  Files to overwrite: ${summary.overwrite}`);
    console.log(`  Files unchanged:    ${summary.unchanged}`);
    console.log(`  Total:              ${summary.total}`);
    console.log("");

    const conflicts = result.conflicts ?? [];
    console.log(
      `Conflicts: ${conflicts.length > 0 ? conflicts.join(", ") : "none"}`,
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

    const response = await fetch(
      `${entry.runtimeUrl}/v1/migrations/import`,
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

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `Error: Import failed (${response.status}): ${body}`,
      );
      process.exit(1);
    }

    const result = (await response.json()) as ImportResponse;

    if (!result.success) {
      console.error(`Error: Import failed — ${result.reason ?? "unknown reason"}`);
      for (const err of result.errors ?? []) {
        console.error(`  - ${err}`);
      }
      process.exit(1);
    }

    // Print import report
    const summary = result.summary ?? {
      created: 0,
      overwritten: 0,
      skipped: 0,
      backups_created: 0,
    };
    console.log("✅ Restore complete.");
    console.log(`  Files created:     ${summary.created}`);
    console.log(`  Files overwritten: ${summary.overwritten}`);
    console.log(`  Files skipped:     ${summary.skipped}`);
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
