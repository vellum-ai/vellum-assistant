import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import pino from "pino";
import pinoPretty from "pino-pretty";
import { logSerializers } from "./log-redact.js";

export type LogFileConfig = {
  dir: string | undefined;
  retentionDays: number;
};

const LOG_FILE_PREFIX = "gateway-";
const LOG_FILE_SUFFIX = ".log";
export const LOG_FILE_PATTERN = /^gateway-(\d{4}-\d{2}-\d{2})\.log$/;

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
let activeConfig: LogFileConfig | null = null;

function buildLogger(config: LogFileConfig | null): pino.Logger {
  if (!config?.dir) {
    return pino(
      { name: "gateway", serializers: logSerializers },
      pinoPretty({ destination: 1 }),
    );
  }

  if (!existsSync(config.dir)) {
    mkdirSync(config.dir, { recursive: true });
  }

  const today = formatDate(new Date());
  const filePath = logFilePathForDate(config.dir, new Date());
  const fileStream = pino.destination({
    dest: filePath,
    sync: true,
    mkdir: true,
    mode: 0o600,
  });
  // Tighten permissions on pre-existing log files that may have been created with looser modes
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* best-effort */
  }

  activeLogDate = today;
  activeConfig = config;

  return pino(
    { name: "gateway", serializers: logSerializers },
    pino.multistream([
      { stream: fileStream, level: "info" as const },
      { stream: pinoPretty({ destination: 1 }), level: "info" as const },
    ]),
  );
}

function ensureCurrentDate(): void {
  if (!activeConfig?.dir || !activeLogDate) return;
  const today = formatDate(new Date());
  if (today !== activeLogDate) {
    rootLogger = buildLogger(activeConfig);
  }
}

export function initLogger(config: LogFileConfig): void {
  rootLogger = buildLogger(config);

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
