import { mkdirSync } from "fs";
import { homedir } from "os";
import { join, posix, win32 } from "path";

function isPathInside(
  parent: string,
  candidate: string,
  pathApi: typeof posix,
): boolean {
  const relativePath = pathApi.relative(parent, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relativePath)
  );
}

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

function safeName(
  assistantId: string,
  retiredDir: string,
  pathApi: typeof posix,
): string {
  validateAssistantName(assistantId);
  // Canonicalize and verify the result stays inside the retired directory
  const candidate = pathApi.resolve(retiredDir, pathApi.basename(assistantId));
  if (!isPathInside(retiredDir, candidate, pathApi)) {
    throw new Error(`Invalid assistant name: '${assistantId}'`);
  }
  return pathApi.basename(assistantId);
}

export function resolveRetiredFilePath(
  assistantId: string,
  extension: "tar.gz" | "json",
  retiredDir: string,
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  const pathApi = hostPlatform === "win32" ? win32 : posix;
  return pathApi.join(
    retiredDir,
    `${safeName(assistantId, retiredDir, pathApi)}.${extension}`,
  );
}

export function getArchivePath(assistantId: string): string {
  return resolveRetiredFilePath(assistantId, "tar.gz", getRetiredDir());
}

export function getMetadataPath(assistantId: string): string {
  return resolveRetiredFilePath(assistantId, "json", getRetiredDir());
}
