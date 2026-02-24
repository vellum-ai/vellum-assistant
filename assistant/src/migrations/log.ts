/**
 * Stderr-only logger for migration code. Using the pino logger during
 * migration is unsafe because pino initialization calls ensureDataDir(),
 * which pre-creates workspace destination directories and causes migration
 * moves to no-op.
 */
export function migrationLog(level: 'info' | 'warn' | 'debug', msg: string, data?: Record<string, unknown>): void {
  if (level === 'debug') return; // suppress debug-level migration noise
  const prefix = level === 'warn' ? 'WARN' : 'INFO';
  const extra = data ? ' ' + JSON.stringify(data) : '';
  process.stderr.write(`[migration] ${prefix}: ${msg}${extra}\n`);
}
