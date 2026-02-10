import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Returns the raw platform string from Node.js (e.g. 'darwin', 'linux', 'win32').
 * Prefer this over accessing process.platform directly so all platform
 * detection is routed through this module.
 */
export function getPlatformName(): string {
  return process.platform;
}

/**
 * Returns the platform-specific clipboard copy command, or null if
 * clipboard access is not supported on the current platform.
 */
export function getClipboardCommand(): string | null {
  if (isMacOS()) return 'pbcopy';
  if (isLinux()) return 'xclip -selection clipboard';
  return null;
}

export function getDataDir(): string {
  return join(homedir(), '.vellum');
}

export function getSocketPath(): string {
  return join(getDataDir(), 'vellum.sock');
}

export function getPidPath(): string {
  return join(getDataDir(), 'vellum.pid');
}

export function getDbPath(): string {
  return join(getDataDir(), 'data', 'assistant.db');
}

export function getLogPath(): string {
  return join(getDataDir(), 'logs', 'vellum.log');
}

export function ensureDataDir(): void {
  const base = getDataDir();
  const dirs = [
    base,
    join(base, 'data'),
    join(base, 'memory'),
    join(base, 'memory', 'knowledge'),
    join(base, 'logs'),
    join(base, 'skills'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
