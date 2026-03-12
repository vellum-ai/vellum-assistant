import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";

import pino from "pino";
import type { PrettyOptions } from "pino-pretty";
import pinoPretty from "pino-pretty";

import { getDebugStdoutLogs } from "../config/env-registry.js";
import { logSerializers } from "./log-redact.js";
import { getLogPath } from "./platform.js";

/** Common pino-pretty options that inline [module] into the message prefix. */
function prettyOpts(extra?: PrettyOptions): PrettyOptions {
  return {
    messageFormat: "[{module}] {msg}",
    ignore: "module",
    ...extra,
  };
}

export type LogFileConfig = {
  dir: string | undefined;
  retentionDays: number;
};

const LOG_FILE_PREFIX = "assistant-";
const LOG_FILE_SUFFIX = ".log";
const LOG_FILE_PATTERN = /^assistant-(\d{4}-\d{2}-\d{2})\.log$/;

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function logFilePathForDate(dir: string, date: Date): string {
  return join(dir, `${LOG_FILE_PREFIX}${formatDate(date)}${LOG_FILE_SUFFIX}`);
}

export function pruneOldLogFiles(dir: string, retentionDays: number): number {
  if (!existsSync(dir)) return 0;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  cutoff.setUTCHours(0, 0, 0, 0);

  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (!match) continue;
    const fileDate = new Date(match[1] + "T00:00:00Z");
    if (fileDate < cutoff) {
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {
        // best-effort
      }
    }
  }
  return removed;
}

let rootLogger: pino.Logger | null = null;
let activeLogDate: string | null = null;
let activeLogFileConfig: LogFileConfig | null = null;

function buildRotatingLogger(config: LogFileConfig): pino.Logger {
  if (!config.dir) {
    return pino(
      { name: "assistant", serializers: logSerializers },
      pinoPretty(prettyOpts({ destination: 1 })),
    );
  }

  if (!existsSync(config.dir)) {
    mkdirSync(config.dir, { recursive: true });
  }

  const today = formatDate(new Date());
  const filePath = logFilePathForDate(config.dir, new Date());
  const fileDest = pino.destination({
    dest: filePath,
    sync: false,
    mkdir: true,
    mode: 0o600,
  });
  // Tighten permissions on pre-existing log files that may have been created with looser modes
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
  const fileStream = pinoPretty(
    prettyOpts({ destination: fileDest, colorize: false }),
  );

  activeLogDate = today;
  activeLogFileConfig = config;

  // When stdout is not a TTY (e.g. desktop app redirects to a hatch log file),
  // write to the rotating file only — the hatch log already captured early
  // startup output and echoing pino output there is unnecessary duplication.
  if (!process.stdout.isTTY) {
    return pino(
      { name: "assistant", level: "info", serializers: logSerializers },
      fileStream,
    );
  }

  return pino(
    { name: "assistant", level: "info", serializers: logSerializers },
    pino.multistream([
      { stream: fileStream, level: "info" as const },
      {
        stream: pinoPretty(prettyOpts({ destination: 1 })),
        level: "info" as const,
      },
    ]),
  );
}

function ensureCurrentDate(): void {
  if (!activeLogFileConfig?.dir || !activeLogDate) return;
  const today = formatDate(new Date());
  if (today !== activeLogDate) {
    rootLogger = buildRotatingLogger(activeLogFileConfig);
  }
}

export function initLogger(config: LogFileConfig): void {
  rootLogger = buildRotatingLogger(config);

  if (config.dir && config.retentionDays > 0) {
    const removed = pruneOldLogFiles(config.dir, config.retentionDays);
    if (removed > 0) {
      rootLogger.info(
        { removed, retentionDays: config.retentionDays },
        "Pruned old log files",
      );
    }
  }
}

function getRootLogger(): pino.Logger {
  if (activeLogFileConfig) {
    ensureCurrentDate();
  }
  if (!rootLogger) {
    const forceStderr =
      process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
    if (forceStderr) {
      rootLogger = pino(
        {
          level: "info",
          serializers: logSerializers,
        },
        pino.destination(2),
      );
      return rootLogger;
    }

    try {
      const logPath = getLogPath();
      // Use sync: true so the fd is opened immediately. This prevents
      // "sonic boom is not ready yet" errors when commander calls
      // process.exit(0) for --help/--version before the async fd is ready.
      const fileDest = pino.destination({
        dest: logPath,
        sync: true,
        mkdir: true,
        mode: 0o600,
      });
      // Tighten permissions on pre-existing log files that may have been created with looser modes
      try {
        chmodSync(logPath, 0o600);
      } catch {
        /* best-effort */
      }
      const fileStream = pinoPretty(
        prettyOpts({ destination: fileDest, colorize: false }),
      );

      if (getDebugStdoutLogs()) {
        rootLogger = pino(
          { level: "info", serializers: logSerializers },
          pino.multistream([
            { stream: fileStream, level: "info" as const },
            {
              stream: pinoPretty(prettyOpts({ destination: 1 })),
              level: "info" as const,
            },
          ]),
        );
      } else {
        rootLogger = pino(
          { level: "info", serializers: logSerializers },
          fileStream,
        );
      }
    } catch {
      rootLogger = pino(
        {
          level: "info",
          serializers: logSerializers,
        },
        pinoPretty(prettyOpts({ destination: 2 })),
      );
    }
  }
  return rootLogger;
}

/**
 * Truncate a string for debug logging. Returns the original if under maxLen,
 * otherwise returns the first maxLen chars with a suffix indicating how much was cut.
 */
export function truncateForLog(value: string, maxLen = 500): string {
  if (value.length <= maxLen) return value;
  return (
    value.slice(0, maxLen) + `... (${value.length - maxLen} chars truncated)`
  );
}

/**
 * Returns a lazy logger that only initializes pino when a log method is called.
 * This avoids "sonic boom is not ready yet" errors when the process exits
 * quickly (e.g. `assistant --help`).
 */
export function getLogger(name: string): pino.Logger {
  let child: pino.Logger | null = null;
  const handler: ProxyHandler<pino.Logger> = {
    get(_target, prop, receiver) {
      if (!child) {
        child = getRootLogger().child({ module: name });
      }
      const val = Reflect.get(child, prop, receiver);
      if (typeof val === "function") {
        return val.bind(child);
      }
      return val;
    },
  };
  return new Proxy({} as pino.Logger, handler);
}

/**
 * Pino destination that extracts the message text from JSON log entries
 * and writes it as plain text. Routes info/warn to stdout and error/fatal
 * to stderr, matching console.log/console.error behavior.
 */
function cliDestination(fd: number, maxLevel?: number): Writable {
  const output = fd === 2 ? process.stderr : process.stdout;
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        const obj = JSON.parse(chunk.toString());
        if (maxLevel !== undefined && obj.level > maxLevel) {
          callback();
          return;
        }
        output.write((obj.msg ?? "") + "\n", callback);
      } catch {
        output.write(chunk, callback);
      }
    },
  });
}

/**
 * Logger for CLI commands. Outputs plain message text to stdout (info/warn)
 * and stderr (error/fatal) while providing structured log levels through pino.
 * Uses lazy initialization to avoid issues with fast-exit paths like --help.
 */
export function getCliLogger(name: string): pino.Logger {
  let logger: pino.Logger | null = null;
  const handler: ProxyHandler<pino.Logger> = {
    get(_target, prop, receiver) {
      if (!logger) {
        logger = pino(
          { name, level: "trace", serializers: logSerializers },
          pino.multistream([
            { stream: cliDestination(1, 49), level: "trace" as const },
            { stream: cliDestination(2), level: "error" as const },
          ]),
        );
      }
      const val = Reflect.get(logger, prop, receiver);
      if (typeof val === "function") {
        return val.bind(logger);
      }
      return val;
    },
  };
  return new Proxy({} as pino.Logger, handler);
}
