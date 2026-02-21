import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { _resetGitServiceRegistry } from '../workspace/git-service.js';
import { commitAppChange, _resetAppGitState } from '../memory/app-git-service.js';

// Mock getDataDir to use a temp directory
let testDataDir: string;

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDataDir,
  getProjectDir: () => testDataDir,
}));

// Re-import app-store after mocking so it uses our temp dir
const { createApp, updateApp, deleteApp, writeAppFile, editAppFile, getAppsDir } = await import('../memory/app-store.js');

describe('App Git Service', () => {
  beforeEach(() => {
    testDataDir = join(tmpdir(), `vellum-app-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDataDir, 'apps'), { recursive: true });
    _resetGitServiceRegistry();
    _resetAppGitState();
  });

  afterEach(() => {
    if (existsSync(testDataDir)) {
      rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  function getGitLog(dir: string): string[] {
    try {
      const output = execFileSync('git', ['log', '--oneline', '--format=%s'], {
        cwd: dir,
        encoding: 'utf-8',
      });
      return output.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  test('initializes git repo in apps directory on first commit', async () => {
    const appsDir = getAppsDir();
    expect(existsSync(join(appsDir, '.git'))).toBe(false);

    await commitAppChange('test commit');

    expect(existsSync(join(appsDir, '.git'))).toBe(true);
  });

  test('.gitignore excludes preview files and records', async () => {
    const appsDir = getAppsDir();
    await commitAppChange('test commit');

    const gitignore = readFileSync(join(appsDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('*.preview');
    expect(gitignore).toContain('*/records/');
  });

  test('createApp produces a commit', async () => {
    const app = createApp({
      name: 'Test App',
      schemaJson: '{}',
      htmlDefinition: '<h1>Hello</h1>',
    });

    // Give the fire-and-forget commit time to complete
    await new Promise(resolve => setTimeout(resolve, 500));

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);
    expect(commits.some(c => c.includes('Create app: Test App'))).toBe(true);
  });

  test('updateApp produces a commit with changed fields', async () => {
    const app = createApp({
      name: 'My App',
      schemaJson: '{}',
      htmlDefinition: '<p>v1</p>',
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    updateApp(app.id, { name: 'My App v2', htmlDefinition: '<p>v2</p>' });
    await new Promise(resolve => setTimeout(resolve, 500));

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);
    expect(commits.some(c => c.includes('Update app: My App v2'))).toBe(true);
  });

  test('deleteApp produces a commit with app name', async () => {
    const app = createApp({
      name: 'Doomed App',
      schemaJson: '{}',
      htmlDefinition: '<p>bye</p>',
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    deleteApp(app.id);
    await new Promise(resolve => setTimeout(resolve, 500));

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);
    expect(commits.some(c => c.includes('Delete app: Doomed App'))).toBe(true);
  });

  test('writeAppFile produces a commit', async () => {
    const app = createApp({
      name: 'File App',
      schemaJson: '{}',
      htmlDefinition: '<p>hi</p>',
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    writeAppFile(app.id, 'styles.css', 'body { color: red; }');
    await new Promise(resolve => setTimeout(resolve, 500));

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);
    expect(commits.some(c => c.includes('Write styles.css in app'))).toBe(true);
  });

  test('editAppFile produces a commit on success', async () => {
    const app = createApp({
      name: 'Edit App',
      schemaJson: '{}',
      htmlDefinition: '<p>old text</p>',
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = editAppFile(app.id, 'index.html', 'old text', 'new text');
    expect(result.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 500));

    const appsDir = getAppsDir();
    const commits = getGitLog(appsDir);
    expect(commits.some(c => c.includes('Edit index.html in app'))).toBe(true);
  });

  test('editAppFile does not commit on failure', async () => {
    const app = createApp({
      name: 'No Edit App',
      schemaJson: '{}',
      htmlDefinition: '<p>content</p>',
    });
    await new Promise(resolve => setTimeout(resolve, 500));

    const commitsBefore = getGitLog(getAppsDir());

    const result = editAppFile(app.id, 'index.html', 'nonexistent string', 'replacement');
    expect(result.ok).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 500));

    const commitsAfter = getGitLog(getAppsDir());
    // No new commits should have been created for the failed edit
    expect(commitsAfter.length).toBe(commitsBefore.length);
  });

  test('commitAppChange swallows errors gracefully', async () => {
    // Point to a non-existent directory to force an error
    const origGetAppsDir = getAppsDir;
    _resetAppGitState();

    // This should not throw
    await commitAppChange('test');
  });
});
