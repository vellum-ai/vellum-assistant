import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { getLogPath } from './platform.js';

export type LogFileConfig = {
  dir: string | undefined;
  retentionDays: number;
};

const LOG_FILE_PREFIX = 'assistant-';
const LOG_FILE_SUFFIX = '.log';
const LOG_FILE_PATTERN = /^assistant-(\d{4}-\d{2}-\d{2})\.log$/;

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
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
    const fileDate = new Date(match[1] + 'T00:00:00Z');
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
    return pino({ name: 'assistant' }, pinoPretty({ destination: 1 }));
  }

  if (!existsSync(config.dir)) {
    mkdirSync(config.dir, { recursive: true });
  }

  const today = formatDate(new Date());
  const filePath = logFilePathForDate(config.dir, new Date());
  const fileStream = pino.destination({ dest: filePath, sync: false, mkdir: true });

  activeLogDate = today;
  activeLogFileConfig = config;

  const level = process.env.VELLUM_DEBUG === '1' ? 'debug' : 'info';

  if (process.env.VELLUM_DEBUG === '1') {
    const prettyStream = pinoPretty({ destination: 2 });
    return pino(
      { name: 'assistant', level },
      pino.multistream([
        { stream: fileStream, level: 'info' as const },
        { stream: prettyStream, level: 'debug' as const },
      ]),
    );
  }

  return pino(
    { name: 'assistant', level },
    pino.multistream([
      { stream: fileStream, level: 'info' as const },
      { stream: pinoPretty({ destination: 1 }), level: 'info' as const },
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
      rootLogger.info({ removed, retentionDays: config.retentionDays }, 'Pruned old log files');
    }
  }
}

function getRootLogger(): pino.Logger {
  if (activeLogFileConfig) {
    ensureCurrentDate();
  }
  if (!rootLogger) {
    const forceStderr =
      process.env.BUN_TEST === '1'
      || process.env.NODE_ENV === 'test'
      || process.env.VELLUM_LOG_STDERR === '1';
    if (forceStderr) {
      rootLogger = pino(
        { level: process.env.VELLUM_DEBUG === '1' ? 'debug' : 'info' },
        pino.destination(2),
      );
      return rootLogger;
    }

    try {
      const fileStream = pino.destination({ dest: getLogPath(), sync: false, mkdir: true });

      if (process.env.VELLUM_DEBUG === '1') {
        const prettyStream = pinoPretty({ destination: 2 });
        const multi = pino.multistream([
          { stream: fileStream, level: 'info' as const },
          { stream: prettyStream, level: 'debug' as const },
        ]);
        rootLogger = pino({ level: 'debug' }, multi);
      } else if (process.env.DEBUG_STDOUT_LOGS === '1') {
        rootLogger = pino(
          { level: 'info' },
          pino.multistream([
            { stream: fileStream, level: 'info' as const },
            { stream: pinoPretty({ destination: 1 }), level: 'info' as const },
          ]),
        );
      } else {
        rootLogger = pino({ level: 'info' }, fileStream);
      }
    } catch {
      rootLogger = pino({ level: process.env.VELLUM_DEBUG === '1' ? 'debug' : 'info' }, pinoPretty({ destination: 2 }));
    }
  }
  return rootLogger;
}

/** Returns true when VELLUM_DEBUG=1 is set. */
export function isDebug(): boolean {
  return process.env.VELLUM_DEBUG === '1';
}

/**
 * Truncate a string for debug logging. Returns the original if under maxLen,
 * otherwise returns the first maxLen chars with a suffix indicating how much was cut.
 */
export function truncateForLog(value: string, maxLen = 500): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen) + `... (${value.length - maxLen} chars truncated)`;
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
      if (typeof val === 'function') {
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
        output.write((obj.msg ?? '') + '\n', callback);
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
          { name, level: 'trace' },
          pino.multistream([
            { stream: cliDestination(1, 49), level: 'trace' as const },
            { stream: cliDestination(2), level: 'error' as const },
          ]),
        );
      }
      const val = Reflect.get(logger, prop, receiver);
      if (typeof val === 'function') {
        return val.bind(logger);
      }
      return val;
    },
  };
  return new Proxy({} as pino.Logger, handler);
}
