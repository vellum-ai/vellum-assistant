import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Logger } from "pino";
import type { PrettyOptions } from "pino-pretty";

import {
  getDebugStdoutLogs,
  getIsContainerized,
} from "../config/env-registry.js";
import { logSerializers } from "./log-redact.js";
import { getLogsDir } from "./platform.js";

const loadModule = createRequire(import.meta.url);

/**
 * pino loads on first logger construction, not import, so CLI processes that
 * never log skip its ~17 MiB graph. The `.default ?? mod` unwrap handles both
 * the real dual-export and ESM-shaped test mocks.
 */
function loadPino(): typeof import("pino") {
  const mod = loadModule("pino") as { default?: unknown };
  return (mod.default ?? mod) as typeof import("pino");
}

function loadPinoPretty(): typeof import("pino-pretty") {
  const mod = loadModule("pino-pretty") as { default?: unknown };
  return (mod.default ?? mod) as typeof import("pino-pretty");
}

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
export const LOG_FILE_PATTERN = /^assistant-(\d{4}-\d{2}-\d{2})\.log$/;

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function logFilePathForDate(dir: string, date: Date): string {
  return join(dir, `${LOG_FILE_PREFIX}${formatDate(date)}${LOG_FILE_SUFFIX}`);
}

/**
 * Returns the path to today's log file (`<logsDir>/assistant-YYYY-MM-DD.log`).
 * Used by callers that need to open the same file the logger writes to, e.g.
 * the memory worker spawner piping the child's stderr into the log file.
 */
export function getCurrentLogFilePath(): string {
  return logFilePathForDate(getLogsDir(), new Date());
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

let rootLogger: Logger | null = null;
let activeLogDate: string | null = null;
let activeLogFileConfig: LogFileConfig | null = null;

function resolveLogDir(config: LogFileConfig): string | undefined {
  if (!config.dir) return undefined;

  if (!existsSync(config.dir)) {
    try {
      mkdirSync(config.dir, { recursive: true });
    } catch (err) {
      if (getIsContainerized()) {
        // Config has a host-specific path that can't be created inside the
        // container (e.g. /Users/…). Fall back to the default log directory.
        const fallback = getLogsDir();
        console.warn(
          `[logger] Configured logFile.dir "${config.dir}" cannot be created ` +
            `in container (${(err as Error).message}). Falling back to "${fallback}".`,
        );
        if (!existsSync(fallback)) {
          mkdirSync(fallback, { recursive: true });
        }
        return fallback;
      }
      throw err;
    }
  }

  return config.dir;
}

function buildRotatingLogger(config: LogFileConfig): Logger {
  const pino = loadPino();
  const pinoPretty = loadPinoPretty();
  const dir = resolveLogDir(config);
  if (!dir) {
    return pino(
      { name: "assistant", serializers: logSerializers },
      pinoPretty(prettyOpts({ destination: 1 })),
    );
  }

  const today = formatDate(new Date());
  const filePath = logFilePathForDate(dir, new Date());
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
  activeLogFileConfig = { ...config, dir };

  // When stdout is not a TTY (e.g. desktop app redirects to a hatch log file),
  // write to the rotating file only — the hatch log already captured early
  // startup output and echoing pino output there is unnecessary duplication.
  // DEBUG_STDOUT_LOGS opts in to stdout output for any non-TTY environment
  // (containers, background daemons, etc.).
  if (!process.stdout.isTTY && !getDebugStdoutLogs()) {
    return pino(
      { name: "assistant", level: "info", serializers: logSerializers },
      pino.multistream([{ stream: fileStream, level: "info" as const }]),
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

  // Use the resolved dir (may differ from config.dir when containerized)
  const resolvedDir = activeLogFileConfig?.dir;
  if (resolvedDir && config.retentionDays > 0) {
    const removed = pruneOldLogFiles(resolvedDir, config.retentionDays);
    if (removed > 0) {
      rootLogger.info(
        { removed, retentionDays: config.retentionDays },
        "Pruned old log files",
      );
    }
  }
}

function getRootLogger(): Logger {
  if (activeLogFileConfig) {
    ensureCurrentDate();
  }
  if (!rootLogger) {
    const pino = loadPino();
    const pinoPretty = loadPinoPretty();
    const isTest =
      process.env.BUN_TEST === "1" || process.env.NODE_ENV === "test";
    if (isTest) {
      // Silent by default so test output stays readable without per-file
      // `mock.module("../util/logger.js", …)` boilerplate — the mocks this
      // replaces did exactly this, module-wide. Set VELLUM_TEST_LOG_LEVEL
      // (e.g. "info", "debug") to see log output on stderr when debugging
      // a test run.
      rootLogger = pino(
        {
          level: process.env.VELLUM_TEST_LOG_LEVEL ?? "silent",
          serializers: logSerializers,
        },
        pino.destination(2),
      );
      return rootLogger;
    }

    try {
      const logDir = getLogsDir();
      const logPath = logFilePathForDate(logDir, new Date());
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

      // Register state so ensureCurrentDate() rebuilds across UTC midnight.
      activeLogFileConfig = { dir: logDir, retentionDays: 0 };
      activeLogDate = formatDate(new Date());
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
 * quickly (e.g. `assistant --help`). The child is rebuilt whenever the
 * underlying root logger changes (e.g. day rollover, late initLogger()).
 */
export function getLogger(name: string): Logger {
  let cachedRoot: Logger | null = null;
  let child: Logger | null = null;
  const handler: ProxyHandler<Logger> = {
    get(_target, prop, receiver) {
      const root = getRootLogger();
      if (root !== cachedRoot) {
        cachedRoot = root;
        child = root.child({ module: name });
      }
      const val = Reflect.get(child!, prop, receiver);
      if (typeof val === "function") {
        return val.bind(child);
      }
      return val;
    },
  };
  return new Proxy({} as Logger, handler);
}

/**
 * Extract the message text from a pino-style log call: `(msg)` or
 * `(mergeObject, msg)`. Structured fields are discarded — CLI output is the
 * message text only, matching what the pino-backed implementation printed.
 */
function cliWrite(output: NodeJS.WriteStream): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const msg =
      typeof args[0] === "string" ? args[0] : (args[1] as string | undefined);
    output.write((msg ?? "") + "\n");
  };
}

/**
 * Logger for CLI commands. Outputs plain message text to stdout
 * (trace/debug/info/warn) and stderr (error/fatal). Implemented without pino:
 * the CLI only ever prints the message text, and pino's ~70-module graph
 * costs ~17 MiB per process, which short-lived CLI invocations should not
 * pay. Typed as pino's Logger so call sites keep pino call signatures; only
 * the level methods are real, so anything beyond them fails at runtime —
 * extend this object before using other pino APIs in CLI code.
 */
export function getCliLogger(_name: string): Logger {
  const toStdout = cliWrite(process.stdout);
  const toStderr = cliWrite(process.stderr);
  return {
    trace: toStdout,
    debug: toStdout,
    info: toStdout,
    warn: toStdout,
    error: toStderr,
    fatal: toStderr,
  } as unknown as Logger;
}
