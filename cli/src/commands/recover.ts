import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { getBaseDir, saveAssistantEntry } from "../lib/assistant-config.js";
import type { AssistantEntry } from "../lib/assistant-config.js";
import {
  generateLocalSigningKey,
  startLocalDaemon,
  startGateway,
} from "../lib/local.js";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive.js";

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
  //    The guard MUST resolve the same path that `extractArchive` will write
  //    to; otherwise an instanceDir that exists but lacks a `.vellum` child
  //    (partial cleanup, operator-created, …) slips past the check and tar
  //    merges the archive on top of unrelated contents.
  const target = resolveExtractTarget(entry);
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
 * Resolve the directory tar will write to during recovery.
 *
 * Mirrors `retire-local.ts:isNamedInstance` (`instanceDir !== getBaseDir()`)
 * so the retire → recover round-trip is symmetric: named instances archived
 * the full instance dir and must be restored there; the legacy default
 * first-local case archived only the `.vellum` subdir and must be restored
 * under `<instanceDir>/.vellum`. Legacy entries without `resources` fall
 * back to the original single-tenant `~/.vellum` location.
 *
 * Exported (via internal use) so the collision guard in `recover()` and the
 * extraction target in `extractArchive()` can't drift — they MUST resolve to
 * the exact same path or the guard fails to protect a real collision.
 */
export function resolveExtractTarget(entry: AssistantEntry): string {
  if (!entry.resources) {
    return join(homedir(), ".vellum");
  }
  const isNamedInstance = entry.resources.instanceDir !== getBaseDir();
  return isNamedInstance
    ? entry.resources.instanceDir
    : join(entry.resources.instanceDir, ".vellum");
}

/**
 * Extract a retired archive into the entry's resolved target directory.
 *
 * `retire-local.ts` archives the CONTENTS of the instance's data dir (no
 * wrapper directory). For named instances, that content is the full instance
 * dir (workspace, .vellum/, etc.). For the legacy default case (pre
 * env-data-layout first-local), it's the contents of `<instanceDir>/.vellum`.
 * `resolveExtractTarget` mirrors retire-local's `isNamedInstance` check so
 * the round-trip restores the original layout.
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
  const extractTarget = resolveExtractTarget(entry);
  mkdirSync(extractTarget, { recursive: true });
  // Run tar synchronously via child_process. We intentionally do NOT route
  // this through `../lib/step-runner.exec` because recover should keep its
  // extraction path dependency-free (it's a destructive restore and the
  // fewer moving parts the better) — and so the round-trip unit test can
  // exercise this helper without also having to re-import the real
  // step-runner module.
  const res = spawnSync("tar", ["xzf", archivePath, "-C", extractTarget], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    throw new Error(
      `tar exited with code ${res.status} while extracting ${archivePath}`,
    );
  }
}
