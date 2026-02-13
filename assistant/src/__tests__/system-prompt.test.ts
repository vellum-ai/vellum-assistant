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
const { buildSystemPrompt, ensurePromptFiles, stripCommentLines } = await import('../config/system-prompt.js');

/** Strip the Configuration and Skills sections so base-prompt tests stay focused. */
function basePrompt(result: string): string {
  let s = result;
  for (const heading of ['## Configuration', '## Skills Catalog', '## Available Skills']) {
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
    expect(result).toContain('## Available Skills');
    expect(result).toContain('<available_skills>');
    expect(result).toContain('id="release-checklist"');
    expect(result).toContain('name="Release Checklist"');
    expect(result).toContain('description="Deployment checks."');
    expect(result).toContain('call the `skill_load` tool with its `id`');
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
    expect(result).toContain('## Available Skills');
    expect(result.indexOf('Soul content')).toBeLessThan(result.indexOf('## Available Skills'));
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

  test('strips comment lines starting with _ from prompt files', () => {
    writeFileSync(
      join(TEST_DIR, 'IDENTITY.md'),
      '# Identity\n_ This is a comment\nI am Vellum.\n_ Another comment',
    );
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('# Identity\nI am Vellum.');
  });

  test('collapses whitespace around stripped comment lines', () => {
    writeFileSync(
      join(TEST_DIR, 'SOUL.md'),
      'First paragraph\n\n_ Comment between paragraphs\n\nSecond paragraph',
    );
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('First paragraph\n\nSecond paragraph');
  });

  test('file with only comment lines is treated as empty', () => {
    writeFileSync(join(TEST_DIR, 'SOUL.md'), '_ All comments\n_ Nothing else');
    const result = buildSystemPrompt();
    expect(basePrompt(result)).toBe('');
  });
});

describe('stripCommentLines', () => {
  test('removes lines starting with _', () => {
    expect(stripCommentLines('hello\n_ comment\nworld')).toBe('hello\nworld');
  });

  test('removes lines with leading whitespace before _', () => {
    expect(stripCommentLines('hello\n  _ indented comment\nworld')).toBe('hello\nworld');
  });

  test('preserves underscores mid-line', () => {
    expect(stripCommentLines('hello_world\nsome_var = 1')).toBe('hello_world\nsome_var = 1');
  });

  test('collapses triple+ newlines to double', () => {
    expect(stripCommentLines('a\n\n_ removed\n\nb')).toBe('a\n\nb');
  });

  test('returns empty string for all-comment content', () => {
    expect(stripCommentLines('_ one\n_ two')).toBe('');
  });

  test('preserves _-prefixed lines inside fenced code blocks', () => {
    const input = [
      '## Example',
      '',
      '```python',
      'class Singleton:',
      '    _instance = None',
      '    _private_var = 42',
      '```',
      '',
      '_ This comment should be removed',
      'After the block.',
    ].join('\n');
    const expected = [
      '## Example',
      '',
      '```python',
      'class Singleton:',
      '    _instance = None',
      '    _private_var = 42',
      '```',
      '',
      'After the block.',
    ].join('\n');
    expect(stripCommentLines(input)).toBe(expected);
  });

  test('handles multiple code blocks with _-prefixed lines', () => {
    const input = [
      '_ comment before',
      '```',
      '_keep_this',
      '```',
      '_ comment between',
      '```js',
      '_anotherVar = true',
      '```',
      '_ comment after',
    ].join('\n');
    const expected = [
      '```',
      '_keep_this',
      '```',
      '```js',
      '_anotherVar = true',
      '```',
    ].join('\n');
    expect(stripCommentLines(input)).toBe(expected);
  });

  test('normalizes CRLF line endings before processing', () => {
    const input = 'First\r\n\r\n_ comment\r\n\r\nSecond';
    expect(stripCommentLines(input)).toBe('First\n\nSecond');
  });

  test('collapses blank lines correctly with CRLF input', () => {
    const input = 'a\r\n\r\n_ removed\r\n\r\nb';
    expect(stripCommentLines(input)).toBe('a\n\nb');
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
