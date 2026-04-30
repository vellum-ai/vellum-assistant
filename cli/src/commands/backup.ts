import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import type { AssistantEntry } from "../lib/assistant-config.js";
import { findAssistantByName } from "../lib/assistant-config.js";
import { getBackupsDir, formatSize } from "../lib/backup-ops.js";
import { loadGuardianToken, leaseGuardianToken } from "../lib/guardian-token";
import { pollJobUntilDone } from "../lib/job-polling.js";
import {
  MigrationInProgressError,
  localRuntimeExportToGcs,
  localRuntimePollJobStatus,
} from "../lib/local-runtime-client.js";
import {
  platformRequestSignedUrl,
  readPlatformToken,
} from "../lib/platform-client.js";

export async function backup(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum backup <name> [--output <path>]");
    console.log("");
    console.log(
      "Export a backup of a running assistant as a .vbundle archive.",
    );
    console.log("");
    console.log("Arguments:");
    console.log("  <name>              Name of the assistant to back up");
    console.log("");
    console.log("Options:");
    console.log("  --output <path>     Path to save the .vbundle file");
    console.log(
      "                      (default: ~/.local/share/vellum/backups/<name>-<timestamp>.vbundle)",
    );
    console.log("");
    console.log("Examples:");
    console.log("  vellum backup my-assistant");
    console.log(
      "  vellum backup my-assistant --output ~/Desktop/backup.vbundle",
    );
    process.exit(0);
  }

  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error("Usage: vellum backup <name> [--output <path>]");
    process.exit(1);
  }

  // Parse --output flag
  let outputArg: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) {
      outputArg = args[i + 1];
      break;
    }
  }

  // Look up the instance
  const entry = findAssistantByName(name);
  if (!entry) {
    console.error(`No assistant found with name '${name}'.`);
    console.error("Run 'vellum hatch' first, or check the instance name.");
    process.exit(1);
  }

  // Detect topology and route platform assistants through Django export
  const cloud =
    entry.cloud || (entry.project ? "gcp" : entry.sshUser ? "custom" : "local");

  if (cloud === "apple-container") {
    console.error(
      `Error: '${name}' uses the Apple Containers runtime. Backup is not yet supported for this topology.`,
    );
    process.exit(1);
  }

  if (cloud === "vellum") {
    await backupPlatform(entry, name, outputArg);
    return;
  }

  // Obtain an auth token
  let accessToken: string;
  const tokenData = loadGuardianToken(entry.assistantId);
  if (tokenData && new Date(tokenData.accessTokenExpiresAt) > new Date()) {
    accessToken = tokenData.accessToken;
  } else {
    try {
      const freshToken = await leaseGuardianToken(
        entry.runtimeUrl,
        entry.assistantId,
      );
      accessToken = freshToken.accessToken;
    } catch (err) {
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
  }

  // Call the export endpoint
  let response: Response;
  try {
    response = await fetch(`${entry.runtimeUrl}/v1/migrations/export`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "CLI backup" }),
      signal: AbortSignal.timeout(120_000),
    });

    // Retry once with a fresh token on 401 — the cached token may be stale
    // after a container restart that generated a new gateway signing key.
    if (response.status === 401) {
      let refreshedToken: string | null = null;
      try {
        const freshToken = await leaseGuardianToken(
          entry.runtimeUrl,
          entry.assistantId,
        );
        refreshedToken = freshToken.accessToken;
      } catch {
        // If token refresh fails, fall through to the !response.ok handler below
      }
      if (refreshedToken) {
        accessToken = refreshedToken;
        response = await fetch(`${entry.runtimeUrl}/v1/migrations/export`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ description: "CLI backup" }),
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
        `Error: Could not connect to assistant '${name}'. Is it running?`,
      );
      console.error(`Try: vellum wake ${name}`);
      process.exit(1);
    }
    throw err;
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(`Error: Export failed (${response.status}): ${body}`);
    process.exit(1);
  }

  // Read the response body
  const arrayBuffer = await response.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  // Determine output path
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    outputArg || join(getBackupsDir(), `${name}-${isoTimestamp}.vbundle`);

  // Ensure parent directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  // Write the archive to disk
  writeFileSync(outputPath, data);

  // Print success
  const manifestSha = response.headers.get("X-Vbundle-Manifest-Sha256");
  console.log(`Backup saved to ${outputPath}`);
  console.log(`Size: ${formatSize(data.byteLength)}`);
  if (manifestSha) {
    console.log(`Manifest SHA-256: ${manifestSha}`);
  }
}

// ---------------------------------------------------------------------------
// Platform-managed (cloud="vellum") backup over GCS.
//
// The runtime exports the bundle straight to a platform-issued signed GCS
// URL; the CLI then downloads from GCS to local disk. Bytes never flow
// through Django. Same architectural shape as the platform-source half of
// `vellum teleport`. Output format and success log lines match mode 1
// (runtime-direct local backup) so users see one consistent UX.
//
// Lifecycle: the GCS bucket has a 1-day TTL on `uploads/<org>/*` objects
// (see `vellum-assistant-platform/django/app/assistant/migration/views.py`
// and `migration/services.py`). Backup is single-shot with no import to
// trigger best-effort cleanup, so the bundle sits in GCS up to 24h before
// TTL deletion. No explicit cleanup endpoint exists; relying on TTL is
// intentional.
// ---------------------------------------------------------------------------
async function backupPlatform(
  entry: AssistantEntry,
  name: string,
  outputArg?: string,
): Promise<void> {
  const platformToken = readPlatformToken();
  if (!platformToken) {
    console.error(
      "Not logged in. Run 'vellum login' first (required for platform-managed backup).",
    );
    process.exit(1);
  }
  // Pin upload, download, and runtime requests to the same platform instance
  // the assistant lives on. Using `getPlatformUrl()` instead would target
  // whatever the lockfile / env-var resolves to, which may differ from
  // `entry.runtimeUrl` for staging/dev assistants and end up signing URLs
  // for the wrong GCS bucket. Mirrors the teleport bundlePlatformUrl
  // threading at `cli/src/commands/teleport.ts:1311-1312`.
  const platformUrl = entry.runtimeUrl;
  // Track the working platform token across kickoff/poll/download so a
  // 401-driven refresh during polling stays consistent through the final
  // signed-download request.
  let exportPlatformToken = platformToken;

  // Step 1 — Request a signed upload URL.
  const { url: uploadUrl, bundleKey } = await platformRequestSignedUrl(
    { operation: "upload" },
    exportPlatformToken,
    platformUrl,
  );

  // Step 2 — Kick off runtime export-to-GCS through the platform's
  // wildcard runtime proxy. `localRuntimeExportToGcs` builds the
  // `/v1/assistants/<id>/migrations/export-to-gcs` URL for cloud="vellum"
  // and uses platform-token auth (no guardian-token bootstrap).
  let jobId: string;
  try {
    ({ jobId } = await localRuntimeExportToGcs(entry, exportPlatformToken, {
      uploadUrl,
      description: "CLI backup",
    }));
  } catch (err) {
    if (err instanceof MigrationInProgressError) {
      console.error(
        `Error: Another backup or teleport export is already in progress on '${entry.assistantId}' (job ${err.existingJobId}). Wait for it to finish, then re-run.`,
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(`Export started (job ${jobId})...`);

  // Step 3 — Poll the job through the wildcard proxy. The dedicated
  // `/v1/migrations/jobs/{id}/` endpoint queries platform-side ImportJob
  // records and would 404 on runtime-created job IDs.
  const terminal = await pollJobUntilDone({
    label: "platform export",
    poll: () => localRuntimePollJobStatus(entry, exportPlatformToken, jobId),
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
    console.error(`Error: Export failed: ${terminal.error}`);
    process.exit(1);
  }

  // Step 4 — Request a signed download URL for the same bundle and fetch
  // it from GCS directly. No auth on signed URLs.
  // Use `exportPlatformToken` (not the original `platformToken`) so a
  // poll-loop 401 refresh doesn't get clobbered here — otherwise a long
  // export that recovered mid-poll via re-auth would still 401 on the
  // download-URL request and abort an otherwise successful run.
  const { url: bundleUrl } = await platformRequestSignedUrl(
    { operation: "download", bundleKey },
    exportPlatformToken,
    platformUrl,
  );

  let downloadResponse: Response;
  try {
    downloadResponse = await fetch(bundleUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: Failed to fetch bundle from GCS: ${msg}`);
    process.exit(1);
  }
  if (!downloadResponse.ok) {
    const body = await downloadResponse.text().catch(() => "");
    console.error(
      `Error: Failed to fetch bundle from GCS (${downloadResponse.status}): ${body}`,
    );
    process.exit(1);
  }

  const arrayBuffer = await downloadResponse.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  // Step 5 — Write to disk using the same path resolution mode 1 uses.
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    outputArg || join(getBackupsDir(), `${name}-${isoTimestamp}.vbundle`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, data);

  // Step 6 — Print success. Manifest SHA is included only if the runtime
  // surfaced it via the unified job result; the export-to-gcs runtime
  // route does not set the legacy `X-Vbundle-Manifest-Sha256` response
  // header.
  console.log(`Backup saved to ${outputPath}`);
  console.log(`Size: ${formatSize(data.byteLength)}`);
  const manifestSha =
    terminal.status === "complete" &&
    terminal.result &&
    typeof terminal.result === "object"
      ? (terminal.result as Record<string, unknown>).manifest_sha256
      : undefined;
  if (typeof manifestSha === "string") {
    console.log(`Manifest SHA-256: ${manifestSha}`);
  }
}
