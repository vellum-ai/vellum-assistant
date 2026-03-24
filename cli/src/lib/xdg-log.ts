import type { ChildProcess } from "child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

/** Regex matching pino-pretty's short time prefix, e.g. `[12:07:37.467] `. */
const PINO_TIME_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/;

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

/** Truncate (or create) a log file so each session starts fresh. */
export function resetLogFile(name: string): void {
  try {
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), "");
  } catch {
    /* best-effort */
  }
}

/**
 * Copy the current log file into `destDir` with a timestamped name so that
 * previous session logs are preserved for debugging. No-op when the source
 * file is missing or empty, or when `destDir` does not already exist.
 */
export function archiveLogFile(name: string, destDir: string): void {
  try {
    if (!existsSync(destDir)) return;
    const srcPath = join(getLogDir(), name);
    if (!existsSync(srcPath) || statSync(srcPath).size === 0) return;

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const base = name.replace(/\.log$/, "");
    copyFileSync(srcPath, join(destDir, `${base}-${ts}.log`));
  } catch {
    /* best-effort */
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
 *  prefixing each line with an ISO timestamp and tag (e.g. "[daemon]").
 *  Strips pino-pretty's redundant short time prefix when present.
 *  Streams are unref'd so they don't prevent the parent from exiting.
 *  The fd is closed automatically when both streams end.
 *
 *  When `onLine` is provided, each stripped line is also forwarded to the
 *  callback so callers can tee output to another destination (e.g. stdout
 *  for the desktop app to capture). */
export function pipeToLogFile(
  child: ChildProcess,
  fd: number | "ignore",
  tag: string,
  onLine?: (line: string) => void,
): void {
  if (fd === "ignore" && !onLine) return;
  const writeFd = fd !== "ignore" ? fd : null;
  const tagLabel = `[${tag}]`;
  const streams = [child.stdout, child.stderr].filter(Boolean);
  let ended = 0;

  function onDone() {
    ended++;
    if (ended >= streams.length && writeFd !== null) {
      try {
        closeSync(writeFd);
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
        const stripped = lines[i].replace(PINO_TIME_RE, "");
        if (writeFd !== null) {
          const prefix = `${new Date().toISOString()} ${tagLabel} `;
          try {
            writeSync(writeFd, prefix + stripped + nl);
          } catch {
            /* best-effort */
          }
        }
        if (onLine && stripped) {
          try {
            onLine(stripped);
          } catch {
            /* best-effort */
          }
        }
      }
    });
    stream.on("end", onDone);
    stream.on("error", onDone);
  }
}
