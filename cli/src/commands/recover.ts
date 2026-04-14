import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { loadAllAssistants, saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  generateLocalSigningKey,
  startLocalDaemon,
  startGateway,
} from "../lib/local";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive";
import { exec } from "../lib/step-runner";

export async function recover(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: vellum recover <name>");
    console.log("");
    console.log(
      "Restore a previously retired local assistant from its archive.",
    );
    console.log("");
    console.log("Arguments:");
    console.log("  <name>    Name of the retired assistant to recover");
    process.exit(0);
  }

  const name = process.argv[3];
  if (!name) {
    console.error("Usage: vellum recover <name>");
    process.exit(1);
  }

  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);

  // 1. Verify archive exists
  if (!existsSync(archivePath) || !existsSync(metadataPath)) {
    console.error(`No retired archive found for '${name}'.`);
    process.exit(1);
  }

  // 2. Read and validate metadata before any side effects
  const entry: AssistantEntry = JSON.parse(readFileSync(metadataPath, "utf-8"));
  if (!entry.resources) {
    throw new Error(
      `Retired assistant '${name}' is missing resource configuration. ` +
        `Fix the archive metadata at ${metadataPath} and retry, ` +
        `or run 'vellum hatch' to re-provision with proper resource allocation.`,
    );
  }

  // 3. Check that no known assistant's data directory already occupies the
  //    recovery target. Iterate every entry in the lockfile so multi-instance
  //    installs don't silently clobber a live assistant, and preserve the
  //    legacy `~/.vellum/` scan as a fallback for pre-upgrade installs that
  //    may lack a lockfile entry at all.
  const candidateDirs = new Map<string, string>();
  for (const knownEntry of loadAllAssistants()) {
    if (knownEntry.cloud !== "local" || !knownEntry.resources) continue;
    const dir = join(knownEntry.resources.instanceDir, ".vellum");
    if (!candidateDirs.has(dir)) {
      candidateDirs.set(dir, knownEntry.assistantId);
    }
  }
  const legacyVellumDir = join(homedir(), ".vellum");
  if (!candidateDirs.has(legacyVellumDir)) {
    candidateDirs.set(legacyVellumDir, "legacy ~/.vellum");
  }

  for (const [dir, owner] of candidateDirs) {
    if (existsSync(dir)) {
      console.error(
        `Error: ${dir} already exists (assistant '${owner}'). Retire the current assistant first.`,
      );
      process.exit(1);
    }
  }

  // 4. Extract archive
  await exec("tar", ["xzf", archivePath, "-C", homedir()]);

  // 5. Restore lockfile entry
  saveAssistantEntry(entry);

  // 6. Clean up archive
  unlinkSync(archivePath);
  unlinkSync(metadataPath);

  // 7. Persist signing key so it survives daemon/gateway restarts (same as wake)
  const signingKey = generateLocalSigningKey();
  entry.resources = { ...entry.resources, signingKey };
  saveAssistantEntry(entry);

  // 8. Start daemon + gateway
  await startLocalDaemon(false, entry.resources, { signingKey });
  await startGateway(false, entry.resources, { signingKey });

  console.log(`✅ Recovered assistant '${name}'.`);
}
