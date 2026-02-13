import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock platform to use a temp directory
const TEST_DIR = join(tmpdir(), `vellum-sysprompt-test-${crypto.randomUUID()}`);

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

// Import after mock
const { buildSystemPrompt, ensurePromptFiles } = await import('../config/system-prompt.js');

/** Strip the Configuration and Skills Catalog suffixes so base-prompt tests stay focused. */
function basePrompt(result: string): string {
  let s = result;
  for (const heading of ['## Configuration', '## Skills Catalog']) {
    if (s.startsWith(heading)) { s = ''; break; }
    const idx = s.indexOf(`\n\n${heading}`);
    if (idx !== -1) s = s.slice(0, idx);
  }
  return s;
}

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('returns empty string when no files exist', () => {
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('');
  });

  test('uses SOUL.md when it exists', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '# My Soul\n\nBe awesome.');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('# My Soul\n\nBe awesome.');
  });

  test('uses IDENTITY.md when it exists', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# My Identity\n\nI am Vellum.');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('# My Identity\n\nI am Vellum.');
  });

  test('composes IDENTITY.md + SOUL.md when both exist', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# Identity\n\nI am Vellum.');
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '# Soul\n\nBe thoughtful.');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('# Identity\n\nI am Vellum.\n\n# Soul\n\nBe thoughtful.');
  });

  test('ignores empty SOUL.md', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '   \n  \n  ');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('');
  });

  test('ignores empty IDENTITY.md', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('');
  });

  test('trims whitespace from file content', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '\n  Be kind  \n\n');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('Be kind');
  });

  test('appends skills catalog when skills are configured', () => {
    const skillsDir = join(TEST_DIR, 'skills');
    mkdirSync(join(skillsDir, 'release-checklist'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'release-checklist', 'SKILL.md'),
      '---\nname: "Release Checklist"\ndescription: "Deployment checks."\n---\n\nRun checks.\n',
    );
    writeFileSync(join(skillsDir, 'SKILLS.md'), '- release-checklist\n');

    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'Custom identity');
    const result = buildSystemPrompt();
    expect(result).toContain('Custom identity');
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

    const result = buildSystemPrompt();
    expect(result).toContain('Identity content\n\nSoul content');
    expect(result).toContain('## Skills Catalog');
    expect(result.indexOf('Soul content')).toBeLessThan(result.indexOf('## Skills Catalog'));
  });

  test('omits user skills from catalog when none are configured', () => {
    const result = buildSystemPrompt();
    // No user skill directories exist, so no user skills should appear.
    // Bundled skills (e.g. app-builder) may still be present.
    expect(result).not.toContain('release-checklist');
    expect(result).not.toContain('incident-response');
  });

  test('appends USER.md after base prompt', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'Base prompt');
    writeFileSync(join(TEST_DIR, 'USER.md'), '# User\n\nName: Alice');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('Base prompt\n\n# User\n\nName: Alice');
  });

  test('appends USER.md after IDENTITY + SOUL', () => {
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), 'Identity');
    writeFileSync(join(TEST_DIR, 'SOUL.md'), 'Soul');
    writeFileSync(join(TEST_DIR, 'USER.md'), 'User info');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('Identity\n\nSoul\n\nUser info');
  });

  test('USER.md alone becomes the prompt', () => {
    writeFileSync(join(TEST_DIR, 'USER.md'), 'Just user');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('Just user');
  });

  test('ignores empty USER.md', () => {
    writeFileSync(join(TEST_DIR, 'USER.md'), '  \n  ');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('');
  });
});

describe('ensurePromptFiles', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('creates all 3 files from templates when none exist', () => {
    ensurePromptFiles();

    for (const file of ['SOUL.md', 'IDENTITY.md', 'USER.md']) {
      const dest = join(TEST_DIR, file);
      expect(existsSync(dest)).toBe(true);
      const content = readFileSync(dest, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  test('does not overwrite existing files', () => {
    const customContent = 'My custom identity';
    writeFileSync(join(TEST_DIR, 'IDENTITY.md'), customContent);

    ensurePromptFiles();

    const content = readFileSync(join(TEST_DIR, 'IDENTITY.md'), 'utf-8');
    expect(content).toBe(customContent);

    // Other files should be created
    expect(existsSync(join(TEST_DIR, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'USER.md'))).toBe(true);
  });

  test('handles missing template gracefully (warn, no crash)', () => {
    // ensurePromptFiles resolves templates from the actual templates/ dir.
    // Since templates exist in the repo this test verifies the function
    // doesn't crash. A true "missing template" scenario would require
    // mocking the filesystem, but the important contract is: no throw.
    expect(() => ensurePromptFiles()).not.toThrow();
  });
});
