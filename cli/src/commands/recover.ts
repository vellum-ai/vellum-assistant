import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";

import { saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import {
  generateLocalSigningKey,
  startCes,
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
    console.log(
      "Extracts the archived workspace data back to its original location,",
    );
    console.log(
      "restores the lockfile entry, and starts the assistant and gateway.",
    );
    console.log(
      "Archives are stored in $XDG_DATA_HOME/vellum/retired/ (default: ~/.local/share/vellum/retired/).",
    );
    console.log("");
    console.log("Arguments:");
    console.log("  <name>    Name of the retired assistant to recover");
    console.log("");
    console.log("Examples:");
    console.log("  $ vellum recover my-assistant");
    console.log("  $ vellum recover aria-7f3a");
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

  // 3. Check that the recovering entry's own target directory is free.
  const target = join(entry.resources.instanceDir, ".vellum");
  if (existsSync(target)) {
    console.error(
      `Error: ${target} already exists (owned by ${entry.assistantId}). ` +
        `Retire the current assistant first.`,
    );
    process.exit(1);
  }

  // 4. Determine the original target directory, then extract and rename.
  //
  // retireLocal archives either the full instanceDir (named instances) or just
  // the .vellum/ subdirectory (default instance whose instanceDir === homedir()).
  // The directory is staged under `<archive>.staging` inside the retired dir
  // before being packed with `tar -C <retiredDir> <stagingBasename>`, so the
  // top-level entry inside the tarball is always `<name>.tar.gz.staging`.
  //
  // Correct restoration: extract to retiredDir, then rename the staging entry
  // back to the original target path.  Using homedir() as the -C target was
  // wrong for any instance stored outside the home directory.
  const isNamedInstance = entry.resources.instanceDir !== homedir();
  const targetDir = isNamedInstance
    ? entry.resources.instanceDir
    : join(entry.resources.instanceDir, ".vellum");
  const retiredDir = dirname(archivePath);
  const extractedPath = join(retiredDir, basename(archivePath) + ".staging");

  await exec("tar", ["xzf", archivePath, "-C", retiredDir]);
  mkdirSync(dirname(targetDir), { recursive: true });
  renameSync(extractedPath, targetDir);

  // 5. Restore lockfile entry
  saveAssistantEntry(entry);

  // 6. Clean up archive
  unlinkSync(archivePath);
  unlinkSync(metadataPath);

  // 7. Persist signing key and bootstrap secret so they survive daemon/gateway restarts
  const signingKey = generateLocalSigningKey();
  const bootstrapSecret = generateLocalSigningKey();
  entry.resources = { ...entry.resources, signingKey };
  entry.guardianBootstrapSecret = bootstrapSecret;
  saveAssistantEntry(entry);

  // 8. Start CES sibling (opt-in) + daemon + gateway in parallel, the way the
  // Docker topology brings its sibling processes up together. startCes is a
  // no-op unless CES_STANDALONE is set.
  await Promise.all([
    startCes(false, entry.resources),
    startLocalDaemon(false, entry.resources, { signingKey }),
    startGateway(false, entry.resources, { signingKey, bootstrapSecret }),
  ]);

  console.log(`✅ Recovered assistant '${name}'.`);
}
