import { mkdirSync } from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";

export function getRetiredDir(): string {
  const xdgData =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  const dir = join(xdgData, "vellum", "retired");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Throws if the name contains path separators or traversal segments. */
export function validateAssistantName(name: string): void {
  if (
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name === ".." ||
    name === "."
  ) {
    throw new Error(`Invalid assistant name: '${name}'`);
  }
}

function safeName(assistantId: string): string {
  validateAssistantName(assistantId);
  // Canonicalize and verify the result stays inside the retired directory
  const retiredDir = getRetiredDir();
  const candidate = resolve(retiredDir, basename(assistantId));
  if (!candidate.startsWith(retiredDir + "/")) {
    throw new Error(`Invalid assistant name: '${assistantId}'`);
  }
  return basename(assistantId);
}

export function getArchivePath(assistantId: string): string {
  return join(getRetiredDir(), `${safeName(assistantId)}.tar.gz`);
}

export function getMetadataPath(assistantId: string): string {
  return join(getRetiredDir(), `${safeName(assistantId)}.json`);
}
