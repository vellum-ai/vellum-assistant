import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import pino from "pino";
import type { PrettyOptions } from "pino-pretty";
import pinoPretty from "pino-pretty";
import { logSerializers } from "./log-redact.js";

export type LogFileConfig = {
  dir: string | undefined;
  retentionDays: number;
};

/**
 * Common pino-pretty options. Inlines [module] into the message prefix so the
 * formatted line reads `[runtime-proxy] Upstream returned error` instead of
 * dumping the module field separately. Mirrors the assistant logger so files
 * are human-readable on both sides.
 */
function prettyOpts(extra?: PrettyOptions): PrettyOptions {
  return {
    messageFormat: "[{module}] {msg}",
    ignore: "module",
    ...extra,
  };
}

const LOG_FILE_PREFIX = "gateway-";
const LOG_FILE_SUFFIX = ".log";
const LOG_FILE_JSON_SUFFIX = ".jsonl";

/** Matches the human-readable pretty log file (default tail target). */
export const LOG_FILE_PATTERN = /^gateway-(\d{4}-\d{2}-\d{2})\.log$/;

/**
 * Matches the structured JSON-lines sidecar used by `gateway/logs/tail` for
 * server-side level/module filtering. Walking pretty multi-line entries is
 * fragile, so we keep a parallel JSONL file solely for that consumer.
 */
export const LOG_FILE_JSON_PATTERN = /^gateway-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function logFilePathForDate(dir: string, date: Date): string {
  return join(dir, `${LOG_FILE_PREFIX}${formatDate(date)}${LOG_FILE_SUFFIX}`);
}

function jsonLogFilePathForDate(dir: string, date: Date): string {
  return join(
    dir,
    `${LOG_FILE_PREFIX}${formatDate(date)}${LOG_FILE_JSON_SUFFIX}`,
  );
}

export function pruneOldLogFiles(dir: string, retentionDays: number): number {
  if (!existsSync(dir)) return 0;
  // Disabled retention is a no-op. Guarding here (not just in the `prune()`
  // wrapper) lets tests exercise the disable path directly without going
  // through `initLogger`, which is module-level state.
  if (retentionDays <= 0) return 0;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  cutoff.setUTCHours(0, 0, 0, 0);

  let removed = 0;
  for (const name of readdirSync(dir)) {
    const match =
      LOG_FILE_PATTERN.exec(name) ?? LOG_FILE_JSON_PATTERN.exec(name);
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
let activeConfig: LogFileConfig | null = null;

function openSecureDestination(filePath: string): pino.DestinationStream {
  const dest = pino.destination({
    dest: filePath,
    sync: true,
    mkdir: true,
    mode: 0o600,
  });
  // Tighten permissions on pre-existing log files that may have been created
  // with looser modes.
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }
  return dest;
}

function buildLogger(config: LogFileConfig | null): pino.Logger {
  if (!config?.dir) {
    return pino(
      { name: "gateway", serializers: logSerializers },
      pinoPretty(prettyOpts({ destination: 1 })),
    );
  }

  if (!existsSync(config.dir)) {
    mkdirSync(config.dir, { recursive: true });
  }

  const today = formatDate(new Date());
  const now = new Date();

  // Pretty file: human-readable, default tail target. Mirrors assistant.
  const prettyDest = openSecureDestination(logFilePathForDate(config.dir, now));
  const prettyFileStream = pinoPretty(
    prettyOpts({ destination: prettyDest, colorize: false }),
  );

  // JSONL sidecar: machine-readable, consumed by `gateway/logs/tail` for
  // server-side level/module filtering. Same content, raw pino records.
  const jsonFileStream = openSecureDestination(
    jsonLogFilePathForDate(config.dir, now),
  );

  activeLogDate = today;
  activeConfig = config;

  return pino(
    { name: "gateway", serializers: logSerializers },
    pino.multistream([
      { stream: prettyFileStream, level: "info" as const },
      { stream: jsonFileStream, level: "info" as const },
      {
        stream: pinoPretty(prettyOpts({ destination: 1 })),
        level: "info" as const,
      },
    ]),
  );
}

/**
 * Best-effort retention sweep. Called once at startup and again whenever the
 * UTC date rolls over inside a long-lived process, so log files don't outlive
 * `retentionDays` even if the gateway never restarts. No-ops when no dir is
 * configured or retention is disabled (`retentionDays <= 0`).
 */
function prune(config: LogFileConfig | null, logger: pino.Logger | null): void {
  if (!config?.dir) return;
  // `pruneOldLogFiles` short-circuits when retentionDays <= 0, so we don't
  // double-guard here. Keeping the dir check because we have nothing to
  // sweep without a configured directory.
  const removed = pruneOldLogFiles(config.dir, config.retentionDays);
  if (removed > 0) {
    logger?.info(
      { removed, retentionDays: config.retentionDays },
      "Pruned old log files",
    );
  }
}

function ensureCurrentDate(): void {
  if (!activeConfig?.dir || !activeLogDate) return;
  const today = formatDate(new Date());
  if (today !== activeLogDate) {
    const config = activeConfig;
    rootLogger = buildLogger(config);
    // Retention sweep on date rollover so long-lived pods don't accumulate
    // files past `retentionDays`. `pruneOldLogFiles` is best-effort and safe
    // to call on every rollover.
    prune(config, rootLogger);
  }
}

export function initLogger(config: LogFileConfig): void {
  rootLogger = buildLogger(config);
  prune(config, rootLogger);
}

/**
 * Returns a lazy proxy logger that always delegates to the **current**
 * rootLogger. This is critical because module-level `const log = getLogger(...)`
 * calls execute before `initLogger()` runs. Without the proxy, those early
 * child loggers would permanently hold the fallback stdout-only stream and
 * never write to log files.
 */
export function getLogger(name: string): pino.Logger {
  const handler: ProxyHandler<pino.Logger> = {
    get(_target, prop, receiver) {
      ensureCurrentDate();
      if (!rootLogger) {
        rootLogger = buildLogger(null);
      }
      const child = rootLogger.child({ module: name });
      const value = Reflect.get(child, prop, receiver);
      return typeof value === "function" ? value.bind(child) : value;
    },
  };
  // The proxy target is a throwaway logger — all access is intercepted.
  return new Proxy({} as pino.Logger, handler);
}
