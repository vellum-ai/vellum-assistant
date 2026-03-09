/**
 * Standalone log-forwarder process spawned by openLogPipe().
 *
 * Reads from stdin, strips pino-pretty's short time prefix (`[HH:MM:SS.mmm]`),
 * prepends each line with an ISO timestamp and a `[tag]` label, then appends
 * the result to the target log file.
 *
 * Usage: bun run log-forwarder.ts <tag> <logPath>
 */

import { closeSync, openSync, writeSync } from "fs";

const tag = process.argv[2];
const logPath = process.argv[3];

if (!tag || !logPath) {
  process.exit(1);
}

let fd: number;
try {
  fd = openSync(logPath, "a");
} catch {
  process.exit(0);
}

/** Regex matching pino-pretty's short time prefix, e.g. `[12:07:37.467] `. */
const PINO_TIME_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s*/;

let buf = "";

process.stdin.on("data", (chunk: Buffer) => {
  const text = buf + chunk.toString();
  const lines = text.split("\n");
  buf = lines.pop() || "";
  for (const line of lines) {
    const stripped = line.replace(PINO_TIME_RE, "");
    try {
      writeSync(fd, `${new Date().toISOString()} [${tag}] ${stripped}\n`);
    } catch {
      /* best-effort */
    }
  }
});

process.stdin.on("end", () => {
  if (buf) {
    const stripped = buf.replace(PINO_TIME_RE, "");
    try {
      writeSync(fd, `${new Date().toISOString()} [${tag}] ${stripped}\n`);
    } catch {
      /* best-effort */
    }
  }
  try {
    closeSync(fd);
  } catch {
    /* best-effort */
  }
});
