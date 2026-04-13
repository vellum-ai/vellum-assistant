import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { findAssistantByName } from "../lib/assistant-config";
import { getBackupsDir, formatSize } from "../lib/backup-ops.js";
import { loadGuardianToken, leaseGuardianToken } from "../lib/guardian-token";
import {
  readPlatformToken,
  platformInitiateExport,
  platformPollExportStatus,
  platformDownloadExport,
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
    await backupPlatform(name, outputArg, entry.runtimeUrl);
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
// Platform (Vellum-hosted) backup via Django async migration export
// ---------------------------------------------------------------------------

async function backupPlatform(
  name: string,
  outputArg?: string,
  runtimeUrl?: string,
): Promise<void> {
  // Step 1 — Authenticate
  const token = readPlatformToken();
  if (!token) {
    console.error("Not logged in. Run 'vellum login' first.");
    process.exit(1);
  }

  // Step 2 — Initiate export job
  let jobId: string;
  try {
    const result = await platformInitiateExport(
      token,
      "CLI backup",
      runtimeUrl,
    );
    jobId = result.jobId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("401") || msg.includes("403")) {
      console.error("Authentication failed. Run 'vellum login' to refresh.");
      process.exit(1);
    }
    if (msg.includes("429")) {
      console.error(
        "Too many export requests. Please wait before trying again.",
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(`Export started (job ${jobId})...`);

  // Step 3 — Poll for completion
  const POLL_INTERVAL_MS = 2_000;
  const TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
  const deadline = Date.now() + TIMEOUT_MS;
  let downloadUrl: string | undefined;

  while (Date.now() < deadline) {
    let status: { status: string; downloadUrl?: string; error?: string };
    try {
      status = await platformPollExportStatus(jobId, token, runtimeUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Let non-transient errors (e.g. 404 "job not found") propagate immediately
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

    // Still in progress — wait and retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (!downloadUrl) {
    console.error("Export timed out after 5 minutes.");
    process.exit(1);
  }

  // Step 4 — Download bundle
  const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath =
    outputArg || join(getBackupsDir(), `${name}-${isoTimestamp}.vbundle`);

  mkdirSync(dirname(outputPath), { recursive: true });

  const response = await platformDownloadExport(downloadUrl);
  const arrayBuffer = await response.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  writeFileSync(outputPath, data);

  // Step 5 — Print success
  console.log(`Backup saved to ${outputPath}`);
  console.log(`Size: ${formatSize(data.byteLength)}`);

  const manifestSha = response.headers.get("X-Vbundle-Manifest-Sha256");
  if (manifestSha) {
    console.log(`Manifest SHA-256: ${manifestSha}`);
  }
}
