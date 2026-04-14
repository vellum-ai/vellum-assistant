import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { getBaseDir, saveAssistantEntry } from "../lib/assistant-config";
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

  // 3. Check that the recovering entry's own target directory is free. Only
  //    this one path matters — iterating all lockfile entries would block
  //    recovery whenever any unrelated local assistant is still installed.
  //    Fall back to the legacy `~/.vellum` path for entries without
  //    resources (pre env-data-layout installs).
  const target = entry.resources?.instanceDir
    ? join(entry.resources.instanceDir, ".vellum")
    : join(homedir(), ".vellum");
  if (existsSync(target)) {
    console.error(
      `Error: ${target} already exists (owned by ${entry.assistantId}). ` +
        `Retire the current assistant first.`,
    );
    process.exit(1);
  }

  // 4. Extract archive into the entry's target directory.
  await extractArchive(archivePath, entry);

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

/**
 * Extract a retired archive into the entry's resolved target directory.
 *
 * `retire-local.ts` archives the CONTENTS of the instance's data dir (no
 * wrapper directory). For named instances, that content is the full instance
 * dir (workspace, .vellum/, etc.). For the legacy default case (pre
 * env-data-layout first-local), it's the contents of `<instanceDir>/.vellum`.
 * We mirror the same `isNamedInstance` check here so the round-trip restores
 * the original layout.
 *
 * The compare-against-`getBaseDir()` is intentional: `retire-local.ts` uses
 * the same helper, which honors `BASE_DATA_DIR` for e2e tests. The two sides
 * must agree on what "named instance" means for round-trip to work.
 */
export async function extractArchive(
  archivePath: string,
  entry: AssistantEntry,
): Promise<void> {
  if (!entry.resources) {
    throw new Error(
      `Cannot extract archive for '${entry.assistantId}': missing resources.`,
    );
  }
  // Mirror retire-local.ts:isNamedInstance. An entry is a named
  // multi-instance install when its resources.instanceDir is not the
  // base dir (`homedir()`, or `BASE_DATA_DIR` under test). Named instances
  // archived the full instance dir; default instances archived only the
  // .vellum subdir. The default branch is a backwards-compat path —
  // all new hatches go through the named-instance path.
  const isNamedInstance = entry.resources.instanceDir !== getBaseDir();
  const extractTarget = isNamedInstance
    ? entry.resources.instanceDir
    : join(entry.resources.instanceDir, ".vellum");
  mkdirSync(extractTarget, { recursive: true });
  await exec("tar", ["xzf", archivePath, "-C", extractTarget]);
}
