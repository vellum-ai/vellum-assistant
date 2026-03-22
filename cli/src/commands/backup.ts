import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { findAssistantByName } from "../lib/assistant-config";
import { getBackupsDir, formatSize } from "../lib/backup-ops.js";
import { loadGuardianToken, leaseGuardianToken } from "../lib/guardian-token";

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
