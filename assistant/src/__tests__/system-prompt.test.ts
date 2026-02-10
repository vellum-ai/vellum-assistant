import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock platform to use a temp directory
const TEST_DIR = join(tmpdir(), `vellum-sysprompt-test-${crypto.randomUUID()}`);

import { mock } from 'bun:test';

mock.module('../util/platform.js', () => ({
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// Import after mock
const { buildSystemPrompt } = await import('../config/system-prompt.js');
const { DEFAULT_SYSTEM_PROMPT } = await import('../config/defaults.js');

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('returns DEFAULT_SYSTEM_PROMPT when no files exist and no config', () => {
    const result = buildSystemPrompt();
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('returns config systemPrompt when no files exist', () => {
    const result = buildSystemPrompt('Custom config prompt');
    expect(result).toBe('Custom config prompt');
  });

  test('uses SOUL.md when it exists', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '# My Soul\n\nBe awesome.');
    const result = buildSystemPrompt();
    expect(result).toBe('# My Soul\n\nBe awesome.');
  });

  test('uses IDENTITY.md when it exists', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# My Identity\n\nI am Vellum.');
    const result = buildSystemPrompt();
    expect(result).toBe('# My Identity\n\nI am Vellum.');
  });

  test('composes IDENTITY.md + SOUL.md when both exist', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# Identity\n\nI am Vellum.');
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '# Soul\n\nBe thoughtful.');
    const result = buildSystemPrompt();
    expect(result).toBe('# Identity\n\nI am Vellum.\n\n# Soul\n\nBe thoughtful.');
  });

  test('SOUL.md and IDENTITY.md take priority over config systemPrompt', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), 'Soul content');
    const result = buildSystemPrompt('Should be ignored');
    expect(result).toBe('Soul content');
  });

  test('ignores empty SOUL.md', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '   \n  \n  ');
    const result = buildSystemPrompt('Fallback');
    expect(result).toBe('Fallback');
  });

  test('ignores empty IDENTITY.md', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '');
    const result = buildSystemPrompt('Fallback');
    expect(result).toBe('Fallback');
  });

  test('trims whitespace from file content', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '\n  Be kind  \n\n');
    const result = buildSystemPrompt();
    expect(result).toBe('Be kind');
  });

  test('appends skills catalog when skills are configured', () => {
    const skillsDir = join(TEST_DIR, 'skills');
    mkdirSync(join(skillsDir, 'release-checklist'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'release-checklist', 'SKILL.md'),
      '---\nname: "Release Checklist"\ndescription: "Deployment checks."\n---\n\nRun checks.\n',
    );
    writeFileSync(join(skillsDir, 'SKILLS.md'), '- release-checklist\n');

    const result = buildSystemPrompt('Custom config prompt');
    expect(result).toContain('Custom config prompt');
    expect(result).toContain('## Skills Catalog');
    expect(result).toContain('`release-checklist` - Release Checklist: Deployment checks.');
    expect(result).toContain('call the `skill_load` tool');
  });

  test('keeps SOUL.md and IDENTITY.md additive with skills', () => {
    const skillsDir = join(TEST_DIR, 'skills');
    mkdirSync(join(skillsDir, 'incident-response'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'incident-response', 'SKILL.md'),
      '---\nname: "Incident Response"\ndescription: "Triage and mitigation."\n---\n\nFollow runbook.\n',
    );
    writeFileSync(join(skillsDir, 'SKILLS.md'), '- incident-response\n');
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'Identity content');
    writeFileSync(join(TEST_DIR, 'SOUL.md'), 'Soul content');

    const result = buildSystemPrompt('Fallback');
    expect(result).toContain('Identity content\n\nSoul content');
    expect(result).toContain('## Skills Catalog');
    expect(result.indexOf('Soul content')).toBeLessThan(result.indexOf('## Skills Catalog'));
  });

  test('omits skills catalog when no skills are available', () => {
    const result = buildSystemPrompt('No skills prompt');
    expect(result).toBe('No skills prompt');
    expect(result).not.toContain('## Skills Catalog');
  });
});
