import { existsSync, readFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { saveAssistantEntry } from "../lib/assistant-config";
import type { AssistantEntry } from "../lib/assistant-config";
import { startLocalDaemon, startGateway } from "../lib/local";
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

  // 2. Check ~/.vellum doesn't already exist
  const vellumDir = join(homedir(), ".vellum");
  if (existsSync(vellumDir)) {
    console.error(
      "Error: ~/.vellum already exists. Retire the current assistant first.",
    );
    process.exit(1);
  }

  // 3. Extract archive
  await exec("tar", ["xzf", archivePath, "-C", homedir()]);

  // 4. Restore lockfile entry
  const entry: AssistantEntry = JSON.parse(readFileSync(metadataPath, "utf-8"));
  saveAssistantEntry(entry);

  // 5. Clean up archive
  unlinkSync(archivePath);
  unlinkSync(metadataPath);

  // 6. Start daemon + gateway (same as wake)
  if (!entry.resources) {
    throw new Error(
      `Recovered assistant '${name}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  await startLocalDaemon(false, entry.resources);
  if (!process.env.VELLUM_DESKTOP_APP) {
    await startGateway(undefined, false, entry.resources);
  }

  console.log(`✅ Recovered assistant '${name}'.`);
}
