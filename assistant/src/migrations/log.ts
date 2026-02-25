import pino from 'pino';

import { logSerializers } from '../util/log-redact.js';

/**
 * Standalone pino instance for migration code. This must NOT use getLogger()
 * because that triggers ensureDataDir(), which pre-creates workspace
 * destination directories and causes migration moves to no-op.
 *
 * Writes to stderr only — no log files that might not exist yet.
 */
const migrationLogger: pino.Logger = pino(
  { name: 'migration', level: 'info', serializers: logSerializers },
  pino.destination(2),
);

export function migrationLog(level: 'info' | 'warn' | 'debug', msg: string, data?: Record<string, unknown>): void {
  if (level === 'debug') return;
  if (data) {
    migrationLogger[level](data, msg);
  } else {
    migrationLogger[level](msg);
  }
}
