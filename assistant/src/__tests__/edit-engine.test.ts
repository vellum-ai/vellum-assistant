import { describe, expect, test } from 'bun:test';
import { applyEdit } from '../tools/shared/filesystem/edit-engine.js';

describe('applyEdit', () => {
  // -----------------------------------------------------------------------
  // Exact unique replacement
  // -----------------------------------------------------------------------

  test('exact unique replacement', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const result = applyEdit({
      content,
      oldString: 'return "world";',
      newString: 'return "universe";',
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('function hello() {\n  return "universe";\n}');
    expect(result.matchCount).toBe(1);
    expect(result.matchMethod).toBe('exact');
  });

  // -----------------------------------------------------------------------
  // Whitespace / fuzzy match behaviour
  // -----------------------------------------------------------------------

  test('whitespace-normalised match succeeds when indentation differs', () => {
    const content = '    function foo() {\n        return 1;\n    }';
    const result = applyEdit({
      content,
      oldString: '  function foo() {\n    return 1;\n  }',
      newString: '  function bar() {\n    return 2;\n  }',
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchMethod).toBe('whitespace');
    // indentation adjustment should re-indent to match the file's 4-space style
    expect(result.updatedContent).toContain('    function bar()');
    expect(result.matchCount).toBe(1);
  });

  test('fuzzy match succeeds for minor typos', () => {
    const content = 'const value = 42;\nconst other = 10;';
    const result = applyEdit({
      content,
      oldString: 'cosnt value = 42;\nconst other = 10;',
      newString: 'const value = 99;\nconst other = 10;',
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchMethod).toBe('fuzzy');
    expect(result.matchCount).toBe(1);
    expect(result.updatedContent).toContain('const value = 99;');
  });

  // -----------------------------------------------------------------------
  // Ambiguous match
  // -----------------------------------------------------------------------

  test('ambiguous match returns reason and count', () => {
    const content = 'foo bar foo baz foo';
    const result = applyEdit({
      content,
      oldString: 'foo',
      newString: 'qux',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
    if (result.reason !== 'ambiguous') return;
    expect(result.matchCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Not found
  // -----------------------------------------------------------------------

  test('returns not_found when old_string is absent', () => {
    const content = 'hello world';
    const result = applyEdit({
      content,
      oldString: 'goodbye universe',
      newString: 'hi',
      replaceAll: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  test('replace_all returns not_found when old_string is absent', () => {
    const content = 'hello world';
    const result = applyEdit({
      content,
      oldString: 'missing',
      newString: 'found',
      replaceAll: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  // -----------------------------------------------------------------------
  // replace_all count correctness
  // -----------------------------------------------------------------------

  test('replace_all replaces every occurrence and reports correct count', () => {
    const content = 'foo bar foo baz foo';
    const result = applyEdit({
      content,
      oldString: 'foo',
      newString: 'qux',
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('qux bar qux baz qux');
    expect(result.matchCount).toBe(3);
    expect(result.matchMethod).toBe('exact');
  });

  test('replace_all with single occurrence reports count 1', () => {
    const content = 'hello world';
    const result = applyEdit({
      content,
      oldString: 'world',
      newString: 'earth',
      replaceAll: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('hello earth');
    expect(result.matchCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('multiline exact replacement', () => {
    const content = 'line1\nline2\nline3\nline4';
    const result = applyEdit({
      content,
      oldString: 'line2\nline3',
      newString: 'replaced2\nreplaced3',
      replaceAll: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('line1\nreplaced2\nreplaced3\nline4');
    expect(result.matchMethod).toBe('exact');
  });
});
