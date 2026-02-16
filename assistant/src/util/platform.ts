import { mkdirSync, existsSync, statSync, unlinkSync, renameSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
/**
 * Stderr-only logger for migration code. Using the pino logger during
 * migration is unsafe because pino initialization calls ensureDataDir(),
 * which pre-creates workspace destination directories and causes migration
 * moves to no-op.
 */
function migrationLog(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void {
  const prefix = level === 'warn' ? 'WARN' : 'INFO';
  const extra = data ? ' ' + JSON.stringify(data) : '';
  process.stderr.write(`[migration] ${prefix}: ${msg}${extra}\n`);
}

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
 * Returns the internal data directory (~/.vellum/workspace/data). Runtime
 * databases, logs, memory indices, and other internal state live here.
 */
export function getDataDir(): string {
  return join(getWorkspaceDir(), 'data');
}

/**
 * Returns the IPC blob directory (~/.vellum/workspace/data/ipc-blobs).
 * Temporary blob files for zero-copy IPC payloads live here.
 */
export function getIpcBlobDir(): string {
  return join(getDataDir(), 'ipc-blobs');
}

/**
 * Returns the sandbox root directory (~/.vellum/data/sandbox).
 * Global sandbox state lives under this directory.
 */
export function getSandboxRootDir(): string {
  return join(getDataDir(), 'sandbox');
}

/**
 * Returns the default sandbox working directory (~/.vellum/workspace).
 * This is the workspace root — tool working directories should use this
 * path unless explicitly overridden.
 */
export function getSandboxWorkingDir(): string {
  return getWorkspaceDir();
}

export function getInterfacesDir(): string {
  return join(getDataDir(), 'interfaces');
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
  return getWorkspaceHooksDir();
}

// --- Workspace path primitives ---
// These will become the canonical paths after workspace migration.
// Currently not used by call-sites; wired in later PRs.

/** Returns ~/.vellum/workspace — the workspace root for user-facing state. */
export function getWorkspaceDir(): string {
  return join(getRootDir(), 'workspace');
}

/** Returns ~/.vellum/workspace/config.json */
export function getWorkspaceConfigPath(): string {
  return join(getWorkspaceDir(), 'config.json');
}

/** Returns ~/.vellum/workspace/skills */
export function getWorkspaceSkillsDir(): string {
  return join(getWorkspaceDir(), 'skills');
}

/** Returns ~/.vellum/workspace/hooks */
export function getWorkspaceHooksDir(): string {
  return join(getWorkspaceDir(), 'hooks');
}

/** Returns the workspace path for a prompt file (e.g. IDENTITY.md, SOUL.md, USER.md). */
export function getWorkspacePromptPath(file: string): string {
  return join(getWorkspaceDir(), file);
}

/**
 * Idempotent move: relocates source to destination for migration.
 * - No-op if source is missing (already migrated or never existed).
 * - No-op if destination already exists (avoids clobbering).
 * - Creates destination parent directories as needed.
 * - Logs warning on failure instead of throwing.
 *
 * Exported for testing; not intended for general use outside migrations.
 */
export function migratePath(source: string, destination: string): void {
  if (!existsSync(source)) return;
  if (existsSync(destination)) {
    migrationLog('warn', 'Migration skipped: destination already exists', { source, destination });
    return;
  }
  const destDir = dirname(destination);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  try {
    renameSync(source, destination);
    migrationLog('info', 'Migrated path', { from: source, to: destination });
  } catch (err) {
    migrationLog('warn', 'Failed to migrate path', { err: String(err), from: source, to: destination });
  }
}

/**
 * When migratePath skips config.json because the workspace copy already
 * exists, the legacy root config may still contain keys (e.g. slackWebhookUrl)
 * that were never written to the workspace config. This merges any missing
 * top-level keys from the legacy file into the workspace file so they are
 * not silently lost during upgrade.
 */
function mergeSkippedConfigKeys(legacyPath: string, workspacePath: string): void {
  if (!existsSync(legacyPath) || !existsSync(workspacePath)) return;

  let legacy: Record<string, unknown>;
  let workspace: Record<string, unknown>;
  try {
    legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'));
    workspace = JSON.parse(readFileSync(workspacePath, 'utf-8'));
  } catch {
    return; // malformed JSON — skip silently
  }

  const merged: string[] = [];
  for (const key of Object.keys(legacy)) {
    if (!(key in workspace)) {
      workspace[key] = legacy[key];
      merged.push(key);
    }
  }

  if (merged.length > 0) {
    try {
      writeFileSync(workspacePath, JSON.stringify(workspace, null, 2) + '\n');
      migrationLog('info', 'Merged legacy config keys into workspace config', { keys: merged });
    } catch (err) {
      migrationLog('warn', 'Failed to merge legacy config keys', { err: String(err), keys: merged });
    }
  }
}

/**
 * When migratePath skips the skills directory because the workspace copy
 * already exists (e.g. pre-created by ensureDataDir), the legacy skills
 * directory may still contain individual skill subdirectories that were
 * never moved. This merges any missing skill subdirectories from the
 * legacy path into the workspace skills path so they are not stranded.
 */
function mergeLegacySkills(legacyDir: string, workspaceDir: string): void {
  if (!existsSync(legacyDir) || !existsSync(workspaceDir)) return;

  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(legacyDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const src = join(legacyDir, entry.name);
    const dest = join(workspaceDir, entry.name);
    if (existsSync(dest)) continue; // already present in workspace
    try {
      renameSync(src, dest);
      migrationLog('info', 'Merged legacy skill into workspace', { from: src, to: dest });
    } catch (err) {
      migrationLog('warn', 'Failed to merge legacy skill', { err: String(err), from: src, to: dest });
    }
  }
}

/**
 * Migrate from the flat ~/.vellum layout to the workspace-based layout.
 *
 * Step (a) is special: if the workspace dir doesn't exist yet but the old
 * sandbox working dir (data/sandbox/fs) does, its contents are "extracted"
 * to become the new workspace root via rename. All subsequent moves then
 * land inside that workspace directory.
 *
 * Idempotent: safe to call on every startup — already-migrated items are
 * skipped, and a second run is a no-op.
 */
export function migrateToWorkspaceLayout(): void {
  const root = getRootDir();
  if (!existsSync(root)) return;

  const ws = getWorkspaceDir();

  // (a) Extract data/sandbox/fs -> workspace (only when workspace doesn't exist yet)
  if (!existsSync(ws)) {
    const sandboxFs = join(root, 'data', 'sandbox', 'fs');
    if (existsSync(sandboxFs)) {
      try {
        renameSync(sandboxFs, ws);
        migrationLog('info', 'Extracted sandbox/fs as workspace root', { from: sandboxFs, to: ws });
      } catch (err) {
        migrationLog('warn', 'Failed to extract sandbox/fs', { err: String(err), from: sandboxFs, to: ws });
      }
    }
  }

  // (b)-(h) Move legacy root-level items into workspace
  migratePath(join(root, 'config.json'), join(ws, 'config.json'));
  mergeSkippedConfigKeys(join(root, 'config.json'), join(ws, 'config.json'));
  migratePath(join(root, 'data'), join(ws, 'data'));
  migratePath(join(root, 'hooks'), join(ws, 'hooks'));
  migratePath(join(root, 'IDENTITY.md'), join(ws, 'IDENTITY.md'));
  migratePath(join(root, 'skills'), join(ws, 'skills'));
  mergeLegacySkills(join(root, 'skills'), join(ws, 'skills'));
  migratePath(join(root, 'SOUL.md'), join(ws, 'SOUL.md'));
  migratePath(join(root, 'USER.md'), join(ws, 'USER.md'));
}

export function ensureDataDir(): void {
  const root = getRootDir();
  const workspace = getWorkspaceDir();
  const wsData = join(workspace, 'data');
  const dirs = [
    // Root-level dirs (runtime / protected)
    root,
    join(root, 'protected'),
    // Workspace dirs
    workspace,
    join(workspace, 'hooks'),
    join(workspace, 'skills'),
    // Data sub-dirs under workspace
    wsData,
    join(wsData, 'db'),
    join(wsData, 'qdrant'),
    join(wsData, 'logs'),
    join(wsData, 'memory'),
    join(wsData, 'memory', 'knowledge'),
    join(wsData, 'apps'),
    join(wsData, 'interfaces'),
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
      migrationLog('info', 'Migrated path', { from: oldPath, to: newPath });
    } catch (err) {
      migrationLog('warn', 'Failed to migrate path', { err: String(err), from: oldPath, to: newPath });
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
