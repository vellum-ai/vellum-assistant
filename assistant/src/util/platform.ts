import { mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
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
  const override = process.env.VELLUM_DAEMON_SOCKET?.trim();
  if (override) {
    return expandHomePath(override);
  }
  return join(getDataDir(), 'vellum.sock');
}

function expandHomePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Remove a socket file only if it is actually a Unix socket.
 * Refuses to delete regular files, directories, etc. to prevent
 * accidental data loss when VELLUM_DAEMON_SOCKET points to a non-socket path.
 */
export function removeSocketFile(socketPath: string): void {
  if (!existsSync(socketPath)) return;
  const stat = statSync(socketPath);
  if (!stat.isSocket()) {
    throw new Error(
      `Refusing to remove ${socketPath}: not a Unix socket (found ${stat.isFile() ? 'regular file' : stat.isDirectory() ? 'directory' : 'non-socket'})`,
    );
  }
  unlinkSync(socketPath);
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
    join(base, 'apps'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
