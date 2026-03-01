import { closeSync, mkdirSync, openSync, writeSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Returns the XDG-compatible log directory for Vellum CLI logs. */
export function getLogDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "vellum", "logs");
}

/** Open (or create) a log file in append mode, returning the file descriptor.
 *  Creates the parent directory if it doesn't exist. Returns "ignore" if the
 *  directory or file cannot be created (permissions, read-only filesystem, etc.)
 *  so that callers can fall back to discarding output instead of aborting. */
export function openLogFile(name: string): number | "ignore" {
  try {
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    return openSync(join(dir, name), "a");
  } catch {
    return "ignore";
  }
}

/** Close a file descriptor returned by openLogFile (no-op for "ignore"). */
export function closeLogFile(fd: number | "ignore"): void {
  if (typeof fd === "number") {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
}

/** Write a string to a file descriptor returned by openLogFile (no-op for "ignore"). */
export function writeToLogFile(fd: number | "ignore", msg: string): void {
  if (typeof fd === "number") {
    try { writeSync(fd, msg); } catch { /* best-effort */ }
  }
}
