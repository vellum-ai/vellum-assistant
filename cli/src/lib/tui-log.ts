/**
 * Structured logger for the `vellum client` TUI.
 *
 * Writes timestamped log lines to `<xdg-log-dir>/client-cli.log`
 * (same directory used by `vellum logs` for hatch sessions).  The file is
 * reset on each TUI session start so it always reflects the most recent run.
 *
 * Usage:
 *   import { tuiLog } from "../lib/tui-log";
 *
 *   tuiLog.init();                     // reset + open — call once at startup
 *   tuiLog.info("connected", { url }); // structured write
 *   tuiLog.close();                    // flush + close fd
 *
 * The log is always written — it's cheap (single file append) and invaluable
 * for diagnosing SSE registration, client identity, and proxy issues.
 */

import {
  closeLogFile,
  openLogFile,
  resetLogFile,
  writeToLogFile,
} from "./xdg-log.js";

const LOG_FILE = "client-cli.log";

let fd: number | "ignore" = "ignore";

function write(level: string, msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  writeToLogFile(fd, `${ts} [client] ${level.toUpperCase()} ${msg}${suffix}\n`);
}

export const tuiLog = {
  /** Reset and open the log file. Call once at TUI startup. */
  init() {
    resetLogFile(LOG_FILE);
    fd = openLogFile(LOG_FILE);
  },

  info(msg: string, extra?: Record<string, unknown>) {
    write("INFO", msg, extra);
  },

  warn(msg: string, extra?: Record<string, unknown>) {
    write("WARN", msg, extra);
  },

  error(msg: string, extra?: Record<string, unknown>) {
    write("ERROR", msg, extra);
  },

  /** Close the file descriptor. Safe to call multiple times. */
  close() {
    closeLogFile(fd);
    fd = "ignore";
  },
};
