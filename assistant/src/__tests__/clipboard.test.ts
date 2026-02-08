import { describe, test, expect } from 'bun:test';
import { extractLastCodeBlock } from '../util/clipboard.js';

describe('extractLastCodeBlock', () => {
  test('extracts a simple code block', () => {
    const text = '```\nhello world\n```';
    expect(extractLastCodeBlock(text)).toBe('hello world');
  });

  test('extracts code block with language tag', () => {
    const text = '```typescript\nconst x = 1;\n```';
    expect(extractLastCodeBlock(text)).toBe('const x = 1;');
  });

  test('returns the last code block when multiple exist', () => {
    const text = '```\nfirst\n```\nsome text\n```\nsecond\n```';
    expect(extractLastCodeBlock(text)).toBe('second');
  });

  test('handles empty code blocks', () => {
    const text = '```\n```';
    expect(extractLastCodeBlock(text)).toBe('');
  });

  test('handles empty code blocks with language tag', () => {
    const text = '```python\n```';
    expect(extractLastCodeBlock(text)).toBe('');
  });

  test('does not match inline backticks as closing fence', () => {
    const text = '```\nconst s = "```"\n```';
    expect(extractLastCodeBlock(text)).toBe('const s = "```"');
  });

  test('handles multi-line code blocks', () => {
    const text = '```js\nfunction foo() {\n  return 42;\n}\n```';
    expect(extractLastCodeBlock(text)).toBe('function foo() {\n  return 42;\n}');
  });

  test('returns null when no code blocks exist', () => {
    expect(extractLastCodeBlock('no code here')).toBeNull();
    expect(extractLastCodeBlock('`inline code`')).toBeNull();
  });

  test('extracts last block when separated by text', () => {
    const text = '```\nfirst\n```\nSome explanation\n```\nsecond\n```';
    expect(extractLastCodeBlock(text)).toBe('second');
  });

  test('handles non-empty block followed by empty block with text between', () => {
    const text = '```\nreal code\n```\nSome text\n```\n```';
    expect(extractLastCodeBlock(text)).toBe('');
  });
});
