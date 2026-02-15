import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `vellum-dyn-skill-test-${crypto.randomUUID()}`);

import { mock } from 'bun:test';

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  getHistoryPath: () => join(TEST_DIR, 'history'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

const { buildSystemPrompt } = await import('../config/system-prompt.js');

describe('Dynamic Skill Authoring Workflow prompt section', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('buildSystemPrompt includes dynamic skill workflow section', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toContain('## Dynamic Skill Authoring Workflow');
  });

  test('workflow section mentions all three new tools', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toContain('evaluate_typescript_code');
    expect(result).toContain('scaffold_managed_skill');
    expect(result).toContain('delete_managed_skill');
  });

  test('workflow section includes user confirmation warning', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toContain('explicit user confirmation');
  });

  test('workflow section includes retry limit guidance', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toContain('3 attempts');
  });

  test('workflow section includes session eviction note', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toContain('recreated session');
  });

  test('prompt still includes available skills catalog when skills exist', () => {
    const skillsDir = join(TEST_DIR, 'skills');
    mkdirSync(join(skillsDir, 'test-skill'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'test-skill', 'SKILL.md'),
      '---\nname: "Test Skill"\ndescription: "For testing."\n---\n\nDo testing.\n',
    );
    writeFileSync(join(skillsDir, 'SKILLS.md'), '- test-skill\n');
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');

    const result = buildSystemPrompt();
    expect(result).toContain('## Available Skills');
    expect(result).toContain('id="test-skill"');
    expect(result).toContain('## Dynamic Skill Authoring Workflow');
  });

  test('prompt is additive with IDENTITY/SOUL/USER files', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'Identity here');
    writeFileSync(join(TEST_DIR, 'SOUL.md'), 'Soul here');
    writeFileSync(join(TEST_DIR, 'USER.md'), 'User here');

    const result = buildSystemPrompt();
    expect(result).toContain('Identity here');
    expect(result).toContain('Soul here');
    expect(result).toContain('User here');
    expect(result).toContain('## Dynamic Skill Authoring Workflow');
  });

  test('workflow section includes skill_load instruction', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'I am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toContain('skill_load');
  });
});
