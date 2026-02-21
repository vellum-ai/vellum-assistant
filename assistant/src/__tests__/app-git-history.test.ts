import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _resetGitServiceRegistry } from '../workspace/git-service.js';
import { _resetAppGitState } from '../memory/app-git-service.js';

// Mock getDataDir to use a temp directory
let testDataDir: string;

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDataDir,
  getProjectDir: () => testDataDir,
}));

// Re-import after mocking so modules use our temp dir
const { createApp, updateApp, deleteApp, writeAppFile, editAppFile, getAppsDir } = await import('../memory/app-store.js');
const { getAppHistory, getAppDiff, getAppFileAtVersion, restoreAppVersion, commitAppChange } = await import('../memory/app-git-service.js');

describe('App Git History', () => {
  beforeEach(() => {
    testDataDir = join(tmpdir(), `vellum-app-git-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDataDir, 'apps'), { recursive: true });
    _resetGitServiceRegistry();
    _resetAppGitState();
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  /** Wait for fire-and-forget commits to complete. */
  async function waitForCommits(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  test('getAppHistory returns commits for a specific app', async () => {
    const app = createApp({
      name: 'History App',
      schemaJson: '{}',
      htmlDefinition: '<h1>v1</h1>',
    });
    await waitForCommits();

    updateApp(app.id, { htmlDefinition: '<h1>v2</h1>' });
    await waitForCommits();

    const history = await getAppHistory(app.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toContain('Update app');
    // The create commit may be absorbed into the "Initial commit" on a fresh repo
    expect(history[history.length - 1].message).toMatch(/Create app|Initial commit/);
    expect(history[0].commitHash).toMatch(/^[0-9a-f]+$/);
    expect(history[0].timestamp).toBeGreaterThan(0);
  });

  test('getAppHistory does not return commits for other apps', async () => {
    const app1 = createApp({
      name: 'App One',
      schemaJson: '{}',
      htmlDefinition: '<p>one</p>',
    });
    await waitForCommits();

    const app2 = createApp({
      name: 'App Two',
      schemaJson: '{}',
      htmlDefinition: '<p>two</p>',
    });
    await waitForCommits();

    const history1 = await getAppHistory(app1.id);
    const history2 = await getAppHistory(app2.id);

    // App1's history should only contain its own commits
    expect(history1.every(v => v.message.includes('App One') || v.message.includes('Initial commit'))).toBe(true);
    // App2's history should only contain its own commits
    expect(history2.every(v => v.message.includes('App Two') || v.message.includes('Initial commit'))).toBe(true);
  });

  test('getAppHistory respects limit', async () => {
    const app = createApp({
      name: 'Limited App',
      schemaJson: '{}',
      htmlDefinition: '<p>v1</p>',
    });
    await waitForCommits();

    updateApp(app.id, { htmlDefinition: '<p>v2</p>' });
    await waitForCommits();

    updateApp(app.id, { htmlDefinition: '<p>v3</p>' });
    await waitForCommits();

    const limited = await getAppHistory(app.id, 2);
    expect(limited.length).toBe(2);
  });

  test('getAppDiff shows changes between versions', async () => {
    const app = createApp({
      name: 'Diff App',
      schemaJson: '{}',
      htmlDefinition: '<p>original</p>',
    });
    await waitForCommits();

    const history1 = await getAppHistory(app.id);
    const createHash = history1[0].commitHash;

    updateApp(app.id, { htmlDefinition: '<p>modified</p>' });
    await waitForCommits();

    const history2 = await getAppHistory(app.id);
    const updateHash = history2[0].commitHash;

    const diff = await getAppDiff(app.id, createHash, updateHash);
    expect(diff).toContain('original');
    expect(diff).toContain('modified');
  });

  test('getAppFileAtVersion returns file content at a specific commit', async () => {
    const app = createApp({
      name: 'File Version App',
      schemaJson: '{}',
      htmlDefinition: '<p>version one</p>',
    });
    await waitForCommits();

    const history1 = await getAppHistory(app.id);
    const v1Hash = history1[0].commitHash;

    updateApp(app.id, { htmlDefinition: '<p>version two</p>' });
    await waitForCommits();

    // Get the file at v1 — should show old content
    const v1Content = await getAppFileAtVersion(app.id, 'index.html', v1Hash);
    expect(v1Content).toContain('version one');
    expect(v1Content).not.toContain('version two');

    // Current file should show new content
    const currentContent = readFileSync(join(getAppsDir(), app.id, 'index.html'), 'utf-8');
    expect(currentContent).toContain('version two');
  });

  test('restoreAppVersion restores files and creates a new commit', async () => {
    const app = createApp({
      name: 'Restore App',
      schemaJson: '{}',
      htmlDefinition: '<p>original content</p>',
    });
    await waitForCommits();

    const history1 = await getAppHistory(app.id);
    const originalHash = history1[0].commitHash;

    updateApp(app.id, { htmlDefinition: '<p>new content</p>' });
    await waitForCommits();

    // Verify current content is "new content"
    let current = readFileSync(join(getAppsDir(), app.id, 'index.html'), 'utf-8');
    expect(current).toContain('new content');

    // Restore to original
    await restoreAppVersion(app.id, originalHash);

    // Verify content is restored
    current = readFileSync(join(getAppsDir(), app.id, 'index.html'), 'utf-8');
    expect(current).toContain('original content');

    // Verify a restore commit was created
    const history2 = await getAppHistory(app.id);
    expect(history2[0].message).toContain('Restore app');
  });
});
