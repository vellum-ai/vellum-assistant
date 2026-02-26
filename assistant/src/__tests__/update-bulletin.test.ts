import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- In-memory checkpoint store ---
const store = new Map<string, string>();

mock.module('../memory/checkpoints.js', () => ({
  getMemoryCheckpoint: mock((key: string) => store.get(key) ?? null),
  setMemoryCheckpoint: mock((key: string, value: string) => store.set(key, value)),
}));

// --- Temp directory for workspace paths ---
let tempDir: string;

// Mock platform to avoid env-registry transitive imports.
// All needed exports are stubbed; getWorkspacePromptPath is the only one
// exercised by update-bulletin.ts.
mock.module('../util/platform.js', () => ({
  getWorkspacePromptPath: mock((file: string) => join(tempDir, file)),
  getWorkspaceDir: () => tempDir,
  getRootDir: () => tempDir,
  getDataDir: () => join(tempDir, 'data'),
  getPlatformName: () => 'darwin',
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  ensureDataDir: () => {},
  getDbPath: () => '',
  getLogPath: () => '',
  getHistoryPath: () => '',
  getHooksDir: () => '',
  getSocketPath: () => '',
  getSessionTokenPath: () => '',
  getHttpTokenPath: () => '',
  getPlatformTokenPath: () => '',
  getPidPath: () => '',
  getWorkspaceConfigPath: () => '',
  getWorkspaceSkillsDir: () => '',
  getWorkspaceHooksDir: () => '',
  getIpcBlobDir: () => '',
  getSandboxRootDir: () => '',
  getSandboxWorkingDir: () => '',
  getInterfacesDir: () => '',
  getClipboardCommand: () => null,
  readLockfile: () => null,
  normalizeAssistantId: (id: string) => id,
  writeLockfile: () => {},
  readPlatformToken: () => null,
  readSessionToken: () => null,
  readHttpToken: () => null,
  removeSocketFile: () => {},
  getTCPPort: () => 8765,
  isTCPEnabled: () => false,
  getTCPHost: () => '127.0.0.1',
  isIOSPairingEnabled: () => false,
  migrateToDataLayout: () => {},
  migratePath: () => {},
  migrateToWorkspaceLayout: () => {},
}));

// Mock system-prompt to provide only stripCommentLines without pulling in
// the rest of the system-prompt transitive dependency tree.
mock.module('../config/system-prompt.js', () => {
  // Inline a minimal implementation of stripCommentLines matching production behavior.
  function stripCommentLines(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n');
    let openFenceChar: string | null = null;
    const filtered = normalized.split('\n').filter((line) => {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const char = fenceMatch[1][0];
        if (!openFenceChar) {
          openFenceChar = char;
        } else if (char === openFenceChar) {
          openFenceChar = null;
        }
      }
      if (openFenceChar) return true;
      return !line.trimStart().startsWith('_');
    });
    return filtered
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return { stripCommentLines };
});

mock.module('../version.js', () => ({
  APP_VERSION: '1.0.0',
}));

const { syncUpdateBulletinOnStartup } = await import('../config/update-bulletin.js');

describe('syncUpdateBulletinOnStartup', () => {
  beforeEach(() => {
    store.clear();
    tempDir = join(tmpdir(), `update-bulletin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates workspace file on first eligible run', () => {
    const workspacePath = join(tempDir, 'UPDATES.md');
    expect(existsSync(workspacePath)).toBe(false);

    syncUpdateBulletinOnStartup();

    expect(existsSync(workspacePath)).toBe(true);
    const content = readFileSync(workspacePath, 'utf-8');
    expect(content).toContain('<!-- vellum-update-release:1.0.0 -->');
    expect(content).toContain("What's New");
  });

  it('appends release block when workspace file exists without current marker', () => {
    const workspacePath = join(tempDir, 'UPDATES.md');
    const preExisting = '<!-- vellum-update-release:0.9.0 -->\nOld release notes.\n';
    writeFileSync(workspacePath, preExisting, 'utf-8');

    syncUpdateBulletinOnStartup();

    const content = readFileSync(workspacePath, 'utf-8');
    expect(content).toContain('<!-- vellum-update-release:0.9.0 -->');
    expect(content).toContain('<!-- vellum-update-release:1.0.0 -->');
    expect(content).toContain('Old release notes.');
  });

  it('does not duplicate same marker on repeated runs', () => {
    syncUpdateBulletinOnStartup();
    const workspacePath = join(tempDir, 'UPDATES.md');
    const afterFirst = readFileSync(workspacePath, 'utf-8');

    syncUpdateBulletinOnStartup();
    const afterSecond = readFileSync(workspacePath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
  });

  it('skips completed release', () => {
    store.set('updates:completed_releases', JSON.stringify(['1.0.0']));
    const workspacePath = join(tempDir, 'UPDATES.md');

    syncUpdateBulletinOnStartup();

    expect(existsSync(workspacePath)).toBe(false);
  });

  it('adds current release to active set', () => {
    syncUpdateBulletinOnStartup();

    const raw = store.get('updates:active_releases');
    expect(raw).toBeDefined();
    const active: string[] = JSON.parse(raw!);
    expect(active).toContain('1.0.0');
  });
});
