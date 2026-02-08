import { describe, expect, test } from 'bun:test';
import { formatDiff, formatNewFileDiff } from '../util/diff.js';

// Strip ANSI codes for easier assertion
const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

describe('formatDiff', () => {
  test('returns empty string for identical content', () => {
    const result = formatDiff('hello\nworld\n', 'hello\nworld\n', 'test.ts');
    expect(result).toBe('');
  });

  test('shows single line addition', () => {
    const old = 'line1\nline2\nline3';
    const updated = 'line1\nline2\nnew line\nline3';
    const result = stripAnsi(formatDiff(old, updated, 'test.ts'));
    expect(result).toContain('--- a/test.ts');
    expect(result).toContain('+++ b/test.ts');
    expect(result).toContain('+new line');
    expect(result).not.toContain('-new line');
  });

  test('shows single line removal', () => {
    const old = 'line1\nline2\nline3';
    const updated = 'line1\nline3';
    const result = stripAnsi(formatDiff(old, updated, 'test.ts'));
    expect(result).toContain('-line2');
    expect(result).not.toContain('+line2');
  });

  test('shows line replacement', () => {
    const old = 'const x = 1;\nconst y = 2;\nconst z = 3;';
    const updated = 'const x = 1;\nconst y = 42;\nconst z = 3;';
    const result = stripAnsi(formatDiff(old, updated, 'file.ts'));
    expect(result).toContain('-const y = 2;');
    expect(result).toContain('+const y = 42;');
  });

  test('includes context lines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    const old = lines.join('\n');
    const newLines = [...lines];
    newLines[5] = 'CHANGED';
    const updated = newLines.join('\n');
    const result = stripAnsi(formatDiff(old, updated, 'ctx.ts'));
    // Should include context before and after the change
    expect(result).toContain(' line4');
    expect(result).toContain(' line5');
    expect(result).toContain('-line6');
    expect(result).toContain('+CHANGED');
    expect(result).toContain(' line7');
    expect(result).toContain(' line8');
  });

  test('handles multi-hunk diffs', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const old = lines.join('\n');
    const newLines = [...lines];
    newLines[2] = 'CHANGED_A';
    newLines[17] = 'CHANGED_B';
    const updated = newLines.join('\n');
    const result = stripAnsi(formatDiff(old, updated, 'multi.ts'));
    expect(result).toContain('-line3');
    expect(result).toContain('+CHANGED_A');
    expect(result).toContain('-line18');
    expect(result).toContain('+CHANGED_B');
    // Should have two @@ hunk headers
    const hunkHeaders = result.match(/@@/g);
    expect(hunkHeaders!.length).toBeGreaterThanOrEqual(4); // 2 hunks, each with @@ ... @@
  });

  test('uses ANSI colors for added/removed lines', () => {
    const old = 'old line';
    const updated = 'new line';
    const result = formatDiff(old, updated, 'test.ts');
    // Red for removed
    expect(result).toContain('\x1b[31m-old line\x1b[0m');
    // Green for added
    expect(result).toContain('\x1b[32m+new line\x1b[0m');
  });

  test('handles empty old content (new file)', () => {
    const result = stripAnsi(formatDiff('', 'new content\nline 2', 'new.ts'));
    expect(result).toContain('+new content');
    expect(result).toContain('+line 2');
  });

  test('handles empty new content (file deleted)', () => {
    const result = stripAnsi(formatDiff('old content\nline 2', '', 'del.ts'));
    expect(result).toContain('-old content');
    expect(result).toContain('-line 2');
  });
});

describe('formatNewFileDiff', () => {
  test('shows all lines as additions', () => {
    const content = 'line1\nline2\nline3';
    const result = stripAnsi(formatNewFileDiff(content, 'new.ts'));
    expect(result).toContain('--- /dev/null');
    expect(result).toContain('+++ b/new.ts');
    expect(result).toContain('+line1');
    expect(result).toContain('+line2');
    expect(result).toContain('+line3');
  });

  test('truncates long files', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i + 1}`);
    const content = lines.join('\n');
    const result = stripAnsi(formatNewFileDiff(content, 'big.ts', 10));
    expect(result).toContain('+line1');
    expect(result).toContain('+line10');
    expect(result).not.toContain('+line11');
    expect(result).toContain('... 40 more lines');
  });

  test('does not truncate short files', () => {
    const content = 'a\nb\nc';
    const result = stripAnsi(formatNewFileDiff(content, 'small.ts'));
    expect(result).not.toContain('more lines');
  });
});
