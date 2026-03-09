import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import type { Writable } from "stream";
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
        const stripped = lines[i].replace(PINO_TIME_RE, "");
        const prefix = `${new Date().toISOString()} ${tagLabel} `;
        try {
          writeSync(numFd, prefix + stripped + nl);
        } catch {
          /* best-effort */
        }
      }
    });
    stream.on("end", onDone);
    stream.on("error", onDone);
  }
}

/**
 * Inline script executed by the log-forwarder process spawned in openLogPipe.
 * Reads from stdin, strips pino-pretty's short time prefix, prepends an ISO
 * timestamp + tag, and appends the result to the target log file.
 */
const LOG_FORWARDER_SCRIPT = [
  'const fs = require("fs");',
  "const tag = process.argv[2];",
  "const logPath = process.argv[3];",
  "let fd;",
  'try { fd = fs.openSync(logPath, "a"); } catch { process.exit(0); }',
  "const P = /^\\[\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\]\\s*/;",
  'let b = "";',
  'process.stdin.on("data", (c) => {',
  "  const t = b + c.toString();",
  '  const l = t.split("\\n");',
  '  b = l.pop() || "";',
  "  for (const x of l) {",
  '    const s = x.replace(P, "");',
  '    try { fs.writeSync(fd, new Date().toISOString() + " [" + tag + "] " + s + "\\n"); } catch {}',
  "  }",
  "});",
  'process.stdin.on("end", () => {',
  "  if (b) {",
  '    const s = b.replace(P, "");',
  '    try { fs.writeSync(fd, new Date().toISOString() + " [" + tag + "] " + s + "\\n"); } catch {}',
  "  }",
  "  try { fs.closeSync(fd); } catch {}",
  "});",
].join("\n");

export interface LogPipe {
  /** Value to pass as stdout/stderr in spawn's stdio option. */
  stdio: Writable | number | "ignore";
  /** Close the parent's end of the pipe after spawning the child. */
  detach: () => void;
}

/**
 * Spawn a detached log-forwarder process that reads from a pipe, prepends each
 * line with an ISO timestamp and a `[tag]` label, and writes to the named log
 * file. Returns a {@link LogPipe} whose `stdio` field can be passed directly
 * to `spawn()`'s stdio array for the child's stdout/stderr.
 *
 * Falls back to plain fd-inheritance (no timestamp prefix) when the forwarder
 * cannot be started (e.g. `bun` is not on PATH).
 */
export function openLogPipe(name: string, tag: string): LogPipe {
  try {
    const dir = getLogDir();
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, name);

    const forwarder = spawn("bun", ["-e", LOG_FORWARDER_SCRIPT, tag, logPath], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });

    if (!forwarder.stdin) {
      throw new Error("stdin pipe unavailable");
    }

    const stdinStream: Writable = forwarder.stdin;

    return {
      stdio: stdinStream,
      detach() {
        try {
          stdinStream.destroy();
        } catch {
          /* best-effort */
        }
        forwarder.unref();
      },
    };
  } catch {
    // Fall back to direct fd-inheritance (no timestamp prefix).
    const fd = openLogFile(name);
    return {
      stdio: fd === "ignore" ? "ignore" : fd,
      detach() {
        if (typeof fd === "number") {
          try {
            closeSync(fd);
          } catch {
            /* best-effort */
          }
        }
      },
    };
  }
}
