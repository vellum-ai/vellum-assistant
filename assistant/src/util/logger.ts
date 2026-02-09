import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { getLogPath, ensureDataDir } from './platform.js';

let rootLogger: pino.Logger | null = null;

function getRootLogger(): pino.Logger {
  if (!rootLogger) {
    ensureDataDir();
    const fileStream = pino.destination({ dest: getLogPath(), sync: false, mkdir: true });

    if (process.env.VELLUM_DEBUG === '1') {
      const prettyStream = pinoPretty({ destination: 2 });
      const multi = pino.multistream([
        { stream: fileStream, level: 'info' as const },
        { stream: prettyStream, level: 'debug' as const },
      ]);
      rootLogger = pino({ level: 'debug' }, multi);
    } else {
      rootLogger = pino({ level: 'info' }, fileStream);
    }
  }
  return rootLogger;
}

/**
 * Returns a lazy logger that only initializes pino when a log method is called.
 * This avoids "sonic boom is not ready yet" errors when the process exits
 * quickly (e.g. `assistant --help`).
 */
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
