import { describe, expect,test } from 'bun:test';

import {
  formatConfirmationCommandPreview,
  formatConfirmationInputLines,
  sanitizeUrlForDisplay,
} from '../cli.js';

describe('sanitizeUrlForDisplay', () => {
  test('removes userinfo from absolute URLs', () => {
    const username = 'user';
    const credential = ['s', 'e', 'c', 'r', 'e', 't'].join('');
    const rawUrlObj = new URL('https://example.com/private');
    rawUrlObj.username = username;
    rawUrlObj.password = credential;
    const rawUrl = rawUrlObj.href;

    expect(sanitizeUrlForDisplay(rawUrl)).toBe('https://example.com/private');
  });

  test('leaves URLs without userinfo unchanged', () => {
    expect(sanitizeUrlForDisplay('https://example.com/docs')).toBe('https://example.com/docs');
  });

  test('redacts fallback //userinfo@ patterns when URL parsing fails', () => {
    const userinfo = ['u', 's', 'e', 'r', ':', 'p', 'w'].join('');
    const rawValue = `not-a-url //${userinfo}@example.com`;

    expect(sanitizeUrlForDisplay(rawValue)).toBe('not-a-url //[REDACTED]@example.com');
  });
});

describe('formatConfirmationInputLines', () => {
  test('preserves full old_string and new_string values without truncation', () => {
    const oldString = 'old '.repeat(120);
    const newString = 'new '.repeat(120);
    const lines = formatConfirmationInputLines({
      old_string: oldString,
      new_string: newString,
    });

    expect(lines).toContain(`old_string: ${oldString}`);
    expect(lines).toContain(`new_string: ${newString}`);
    expect(lines.some((line) => line.includes('...'))).toBe(false);
  });

  test('preserves multiline values', () => {
    const lines = formatConfirmationInputLines({
      old_string: 'line1\nline2\nline3',
    });

    expect(lines).toEqual([
      'old_string: line1',
      '  line2',
      '  line3',
    ]);
  });
});

describe('formatConfirmationCommandPreview', () => {
  test('shows concise file_edit preview', () => {
    const preview = formatConfirmationCommandPreview({
      toolName: 'file_edit',
      input: { path: '/tmp/sample.txt' },
    });
    expect(preview).toBe('edit /tmp/sample.txt');
  });
});
