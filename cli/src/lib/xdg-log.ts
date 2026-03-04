import { closeSync, mkdirSync, openSync, writeSync } from "fs";
import type { ChildProcess } from "child_process";
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
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

/** Write a string to a file descriptor returned by openLogFile (no-op for "ignore"). */
export function writeToLogFile(fd: number | "ignore", msg: string): void {
  if (typeof fd === "number") {
    try {
      writeSync(fd, msg);
    } catch {
      /* best-effort */
    }
  }
}

/** Pipe a child process's stdout/stderr to a shared log file descriptor,
 *  prefixing each line with a tag (e.g. "[daemon]" or "[gateway]").
 *  Streams are unref'd so they don't prevent the parent from exiting.
 *  The fd is closed automatically when both streams end. */
export function pipeToLogFile(
  child: ChildProcess,
  fd: number | "ignore",
  tag: string,
): void {
  if (fd === "ignore") return;
  const numFd: number = fd;
  const tagLabel = `[${tag}]`;
  const streams = [child.stdout, child.stderr].filter(Boolean);
  let ended = 0;

  function onDone() {
    ended++;
    if (ended >= streams.length) {
      try {
        closeSync(numFd);
      } catch {
        /* best-effort */
      }
    }
  }

  for (const stream of streams) {
    if (!stream) continue;
    (stream as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
    stream.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i === lines.length - 1 && lines[i] === "") break;
        const nl = i < lines.length - 1 ? "\n" : "";
        const prefix = `${new Date().toISOString()} ${tagLabel} `;
        try {
          writeSync(numFd, prefix + lines[i] + nl);
        } catch {
          /* best-effort */
        }
      }
    });
    stream.on("end", onDone);
    stream.on("error", onDone);
  }
}
