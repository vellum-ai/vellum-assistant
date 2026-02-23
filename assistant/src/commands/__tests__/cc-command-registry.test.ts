import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverCCCommands,
  getCCCommand,
  loadCCCommandTemplate,
  invalidateCCCommandCache,
} from '../cc-command-registry.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cc-cmd-test-'));
  invalidateCCCommandCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  invalidateCCCommandCache();
});

/** Helper to create a .claude/commands/ directory with markdown files. */
function createCommandsDir(base: string, files: Record<string, string>): void {
  const commandsDir = join(base, '.claude', 'commands');
  mkdirSync(commandsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(commandsDir, name), content, 'utf-8');
  }
}

describe('discoverCCCommands', () => {
  test('discovers commands in .claude/commands/', () => {
    createCommandsDir(tmpDir, {
      'hello.md': '# Hello World\nThis is the hello command.',
      'deploy.md': 'Deploy the application to production.',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.size).toBe(2);

    const hello = registry.entries.get('hello');
    expect(hello).toBeDefined();
    expect(hello!.name).toBe('hello');
    expect(hello!.summary).toBe('Hello World');
    expect(hello!.source).toBe(tmpDir);

    const deploy = registry.entries.get('deploy');
    expect(deploy).toBeDefined();
    expect(deploy!.name).toBe('deploy');
    expect(deploy!.summary).toBe('Deploy the application to production.');
  });

  test('child directory commands override parent on name collisions', () => {
    // Create parent commands
    createCommandsDir(tmpDir, {
      'shared.md': 'Parent version of shared command.',
    });

    // Create child directory with overriding command
    const childDir = join(tmpDir, 'project');
    mkdirSync(childDir, { recursive: true });
    createCommandsDir(childDir, {
      'shared.md': 'Child version of shared command.',
    });

    const registry = discoverCCCommands(childDir);
    const shared = registry.entries.get('shared');
    expect(shared).toBeDefined();
    expect(shared!.summary).toBe('Child version of shared command.');
    expect(shared!.source).toBe(childDir);
  });

  test('invalid filenames are skipped', () => {
    createCommandsDir(tmpDir, {
      'valid-name.md': 'A valid command.',
      '.hidden.md': 'Hidden file should be skipped.',
      '-starts-with-dash.md': 'Invalid start character.',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.size).toBe(1);
    expect(registry.entries.has('valid-name')).toBe(true);
    expect(registry.entries.has('.hidden')).toBe(false);
    expect(registry.entries.has('-starts-with-dash')).toBe(false);
  });

  test('non-.md files are ignored', () => {
    createCommandsDir(tmpDir, {
      'readme.txt': 'Not a markdown file.',
      'command.md': 'A real command.',
      'notes.json': '{}',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.size).toBe(1);
    expect(registry.entries.has('command')).toBe(true);
  });

  test('empty directory returns empty registry', () => {
    const commandsDir = join(tmpDir, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.size).toBe(0);
  });

  test('no .claude/commands/ directory returns empty registry', () => {
    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.size).toBe(0);
  });

  test('commands from multiple ancestor levels are merged', () => {
    // Parent has a unique command
    createCommandsDir(tmpDir, {
      'parent-only.md': 'Only in parent.',
    });

    // Child has a different command
    const childDir = join(tmpDir, 'child');
    mkdirSync(childDir, { recursive: true });
    createCommandsDir(childDir, {
      'child-only.md': 'Only in child.',
    });

    const registry = discoverCCCommands(childDir);
    expect(registry.entries.size).toBe(2);
    expect(registry.entries.has('parent-only')).toBe(true);
    expect(registry.entries.has('child-only')).toBe(true);
  });
});

describe('caching', () => {
  test('cache returns same instance within TTL', () => {
    createCommandsDir(tmpDir, {
      'test.md': 'Test command.',
    });

    const first = discoverCCCommands(tmpDir);
    const second = discoverCCCommands(tmpDir);
    expect(first).toBe(second); // same object reference
  });

  test('invalidateCCCommandCache forces re-discovery', () => {
    createCommandsDir(tmpDir, {
      'test.md': 'Test command.',
    });

    const first = discoverCCCommands(tmpDir);

    invalidateCCCommandCache();

    const second = discoverCCCommands(tmpDir);
    expect(first).not.toBe(second); // different object reference
    expect(second.entries.size).toBe(1);
  });

  test('expired TTL forces re-discovery', () => {
    createCommandsDir(tmpDir, {
      'test.md': 'Test command.',
    });

    // Use a very short TTL
    const first = discoverCCCommands(tmpDir, 0);
    const second = discoverCCCommands(tmpDir, 0);
    expect(first).not.toBe(second); // different object reference due to expired TTL
  });
});

describe('getCCCommand', () => {
  test('looks up command by name (case-insensitive)', () => {
    createCommandsDir(tmpDir, {
      'MyCommand.md': 'My command description.',
    });

    const entry = getCCCommand(tmpDir, 'mycommand');
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('MyCommand');

    const entryUpper = getCCCommand(tmpDir, 'MYCOMMAND');
    expect(entryUpper).toBeDefined();
    expect(entryUpper!.name).toBe('MyCommand');
  });

  test('returns undefined for non-existent command', () => {
    createCommandsDir(tmpDir, {
      'exists.md': 'I exist.',
    });

    const entry = getCCCommand(tmpDir, 'nonexistent');
    expect(entry).toBeUndefined();
  });
});

describe('loadCCCommandTemplate', () => {
  test('reads full file content at execution time', () => {
    const fullContent = '---\ntitle: Test\n---\n\n# Test Command\n\nThis is the full template body.\n\n## Arguments\n- arg1: required\n- arg2: optional\n';
    createCommandsDir(tmpDir, {
      'test.md': fullContent,
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('test')!;
    expect(entry).toBeDefined();

    const template = loadCCCommandTemplate(entry);
    expect(template).toBe(fullContent);
  });
});

describe('summary extraction', () => {
  test('skips YAML frontmatter', () => {
    createCommandsDir(tmpDir, {
      'with-frontmatter.md': '---\ntitle: My Command\nauthor: test\n---\n\nActual summary line.',
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('with-frontmatter');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('Actual summary line.');
  });

  test('strips heading markers', () => {
    createCommandsDir(tmpDir, {
      'heading.md': '## This is a heading',
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('heading');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('This is a heading');
  });

  test('strips multiple heading levels', () => {
    createCommandsDir(tmpDir, {
      'h1.md': '# H1 Heading',
      'h3.md': '### H3 Heading',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.get('h1')!.summary).toBe('H1 Heading');
    expect(registry.entries.get('h3')!.summary).toBe('H3 Heading');
  });

  test('skips empty lines before summary', () => {
    createCommandsDir(tmpDir, {
      'empty-lines.md': '\n\n\nFirst real line.',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.get('empty-lines')!.summary).toBe('First real line.');
  });

  test('truncates summary to 100 characters', () => {
    const longLine = 'A'.repeat(150);
    createCommandsDir(tmpDir, {
      'long.md': longLine,
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('long');
    expect(entry).toBeDefined();
    expect(entry!.summary.length).toBe(100);
    expect(entry!.summary).toBe('A'.repeat(100));
  });

  test('handles file with only frontmatter and no content', () => {
    createCommandsDir(tmpDir, {
      'empty-body.md': '---\ntitle: Empty\n---\n',
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('empty-body');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('');
  });

  test('returns empty summary when frontmatter is truncated by partial read', () => {
    // Simulate frontmatter that exceeds SUMMARY_READ_BYTES (1024).
    // The closing --- delimiter will be cut off, causing FRONTMATTER_REGEX to
    // fail. extractSummary should return '' instead of '---'.
    const largeFrontmatter = '---\n' + 'key: ' + 'x'.repeat(1100) + '\n---\n\nActual summary.';
    createCommandsDir(tmpDir, {
      'big-frontmatter.md': largeFrontmatter,
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('big-frontmatter');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('');
  });

  test('returns empty summary when frontmatter is truncated (CRLF)', () => {
    const largeFrontmatter = '---\r\n' + 'key: ' + 'x'.repeat(1100) + '\r\n---\r\n\r\nActual summary.';
    createCommandsDir(tmpDir, {
      'big-frontmatter-crlf.md': largeFrontmatter,
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('big-frontmatter-crlf');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('');
  });

  test('returns empty summary when frontmatter is truncated with multibyte UTF-8 characters', () => {
    // When frontmatter contains multibyte UTF-8 characters (e.g., CJK text),
    // the JavaScript string length (UTF-16 code units) is smaller than the
    // byte length. The truncation guard must compare byte length, not
    // string length, against SUMMARY_READ_BYTES (1024).
    //
    // Each CJK character is 3 bytes in UTF-8 but 1 code unit in UTF-16.
    // We need the total byte count to reach 1024 while string length stays
    // well below 1024 to exercise the bug.
    const cjkChars = '\u4e00'.repeat(340); // 340 chars * 3 bytes = 1020 bytes
    // '---\n' is 4 bytes, so total = 4 + 1020 = 1024 bytes, but string
    // length = 4 + 340 = 344 chars — well under 1024.
    const truncatedContent = '---\n' + cjkChars;
    createCommandsDir(tmpDir, {
      'multibyte-frontmatter.md': truncatedContent,
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('multibyte-frontmatter');
    expect(entry).toBeDefined();
    // Should return '' because the frontmatter opening delimiter is present
    // but the closing delimiter is missing and the byte length reached the
    // read limit — indicating truncation.
    expect(entry!.summary).toBe('');
  });

  test('returns summary for small file starting with thematic break ---', () => {
    // A small markdown file that starts with "---" as a thematic break (not
    // frontmatter) should still have its first content line extracted as a
    // summary, rather than being treated as truncated frontmatter.
    createCommandsDir(tmpDir, {
      'thematic-break.md': '---\nThis is a valid summary after a thematic break.',
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('thematic-break');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('This is a valid summary after a thematic break.');
  });

  test('handles frontmatter with Windows-style line endings', () => {
    createCommandsDir(tmpDir, {
      'crlf.md': '---\r\ntitle: Test\r\n---\r\n\r\nSummary with CRLF.',
    });

    const registry = discoverCCCommands(tmpDir);
    const entry = registry.entries.get('crlf');
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('Summary with CRLF.');
  });
});

describe('command name validation', () => {
  test('accepts valid names with dots, dashes, underscores', () => {
    createCommandsDir(tmpDir, {
      'my-command.md': 'Dashed name.',
      'my_command.md': 'Underscored name.',
      'my.command.md': 'Dotted name.',
      'Command123.md': 'Alphanumeric.',
      'a.md': 'Single char.',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.has('my-command')).toBe(true);
    expect(registry.entries.has('my_command')).toBe(true);
    expect(registry.entries.has('my.command')).toBe(true);
    expect(registry.entries.has('command123')).toBe(true);
    expect(registry.entries.has('a')).toBe(true);
  });

  test('rejects names starting with special characters', () => {
    createCommandsDir(tmpDir, {
      '_start.md': 'Starts with underscore.',
      '.start.md': 'Starts with dot.',
      '-start.md': 'Starts with dash.',
    });

    const registry = discoverCCCommands(tmpDir);
    expect(registry.entries.size).toBe(0);
  });
});
