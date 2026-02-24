import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function getRetiredDir(): string {
  const xdgData =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  const dir = join(xdgData, "vellum", "retired");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getArchivePath(assistantId: string): string {
  return join(getRetiredDir(), `${assistantId}.tar.gz`);
}

export function getMetadataPath(assistantId: string): string {
  return join(getRetiredDir(), `${assistantId}.json`);
}
