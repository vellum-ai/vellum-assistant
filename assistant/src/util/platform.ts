import { mkdirSync, existsSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from './logger.js';

const log = getLogger('platform');

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

/**
 * Returns the root ~/.vellum directory. User-facing files (config, prompt
 * files, skills) and runtime files (socket, PID) live here.
 */
export function getRootDir(): string {
  return join(process.env.BASE_DATA_DIR?.trim() || homedir(), '.vellum');
}

/**
 * Returns the internal data directory (~/.vellum/data). Runtime databases,
 * logs, memory indices, and other internal state live here.
 */
export function getDataDir(): string {
  return join(getRootDir(), 'data');
}

export function getSocketPath(): string {
  const override = process.env.VELLUM_DAEMON_SOCKET?.trim();
  if (override) {
    return expandHomePath(override);
  }
  return join(getRootDir(), 'vellum.sock');
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
  return join(getRootDir(), 'vellum.pid');
}

export function getDbPath(): string {
  return join(getDataDir(), 'db', 'assistant.db');
}

export function getLogPath(): string {
  return join(getDataDir(), 'logs', 'vellum.log');
}

export function getHistoryPath(): string {
  return join(getDataDir(), 'history');
}

export function getHooksDir(): string {
  return join(getRootDir(), 'hooks');
}

export function ensureDataDir(): void {
  const root = getRootDir();
  const data = getDataDir();
  const dirs = [
    root,
    join(root, 'skills'),
    join(root, 'hooks'),
    join(root, 'protected'),
    data,
    join(data, 'db'),
    join(data, 'qdrant'),
    join(data, 'logs'),
    join(data, 'memory'),
    join(data, 'memory', 'knowledge'),
    join(data, 'apps'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Migrate files from the old flat ~/.vellum layout to the new structured
 * layout with data/ and protected/ subdirectories.
 *
 * Idempotent: skips items that have already been migrated.
 * Uses renameSync for atomic moves (same filesystem).
 */
export function migrateToDataLayout(): void {
  const root = getRootDir();
  const data = join(root, 'data');

  if (!existsSync(root)) return;

  function migrateItem(oldPath: string, newPath: string): void {
    if (!existsSync(oldPath)) return;
    if (existsSync(newPath)) return;
    const newDir = dirname(newPath);
    if (!existsSync(newDir)) {
      mkdirSync(newDir, { recursive: true });
    }
    try {
      renameSync(oldPath, newPath);
      log.info({ from: oldPath, to: newPath }, 'Migrated path');
    } catch (err) {
      log.warn({ err, from: oldPath, to: newPath }, 'Failed to migrate path');
    }
  }

  // DB: ~/.vellum/data/assistant.db → ~/.vellum/data/db/assistant.db
  migrateItem(join(data, 'assistant.db'), join(data, 'db', 'assistant.db'));
  migrateItem(join(data, 'assistant.db-wal'), join(data, 'db', 'assistant.db-wal'));
  migrateItem(join(data, 'assistant.db-shm'), join(data, 'db', 'assistant.db-shm'));

  // Qdrant PID: ~/.vellum/qdrant.pid → ~/.vellum/data/qdrant/qdrant.pid
  migrateItem(join(root, 'qdrant.pid'), join(data, 'qdrant', 'qdrant.pid'));

  // Qdrant binary: ~/.vellum/bin/ → ~/.vellum/data/qdrant/bin/
  migrateItem(join(root, 'bin'), join(data, 'qdrant', 'bin'));

  // Logs: ~/.vellum/logs/ → ~/.vellum/data/logs/
  migrateItem(join(root, 'logs'), join(data, 'logs'));

  // Memory: ~/.vellum/memory/ → ~/.vellum/data/memory/
  migrateItem(join(root, 'memory'), join(data, 'memory'));

  // Apps: ~/.vellum/apps/ → ~/.vellum/data/apps/
  migrateItem(join(root, 'apps'), join(data, 'apps'));

  // Browser auth: ~/.vellum/browser-auth/ → ~/.vellum/data/browser-auth/
  migrateItem(join(root, 'browser-auth'), join(data, 'browser-auth'));

  // Browser profile: ~/.vellum/browser-profile/ → ~/.vellum/data/browser-profile/
  migrateItem(join(root, 'browser-profile'), join(data, 'browser-profile'));

  // History: ~/.vellum/history → ~/.vellum/data/history
  migrateItem(join(root, 'history'), join(data, 'history'));

  // Protected files: ~/.vellum/X → ~/.vellum/protected/X
  const protectedDir = join(root, 'protected');
  migrateItem(join(root, 'trust.json'), join(protectedDir, 'trust.json'));
  migrateItem(join(root, 'keys.enc'), join(protectedDir, 'keys.enc'));
  migrateItem(join(root, 'secret-allowlist.json'), join(protectedDir, 'secret-allowlist.json'));
}
