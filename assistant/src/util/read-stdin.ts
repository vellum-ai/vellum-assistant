/**
 * Robust synchronous stdin reader for CLI commands and CLI-side route helpers.
 *
 * Reads file descriptor 0 directly rather than reopening the `/dev/stdin`
 * path. When the process is a spawned subprocess whose stdin is a pipe
 * read-end — e.g. `producer | assistant <cmd>` run by the assistant's shell
 * tool, or `Bun.spawn(..., { stdin: "pipe" })` — `open("/dev/stdin")` can fail
 * with `ENXIO: no such device or address`. On Linux `/dev/stdin` resolves to
 * `/proc/self/fd/0`, and reopening that magic symlink by path is unsupported
 * for some descriptor types (pipe read-ends, sockets); reading the
 * already-open descriptor works uniformly for pipes, files, and TTYs.
 */
import { readFileSync } from "node:fs";

/** Standard input file descriptor. */
export const STDIN_FD = 0;

/**
 * Read all data currently available on stdin as a string.
 *
 * Callers decide their own no-input policy: guard on `process.stdin.isTTY`
 * before calling when a terminal means "no piped input", and wrap any thrown
 * error with an actionable hint (e.g. suggest `--value` / `--file`).
 */
export function readStdinSync(encoding: BufferEncoding = "utf-8"): string {
  return readFileSync(STDIN_FD, encoding);
}
