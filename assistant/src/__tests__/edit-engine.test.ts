import { describe, expect, test } from 'bun:test';
import { applyEdit } from '../tools/shared/filesystem/edit-engine.js';

describe('edit engine', () => {
  // -----------------------------------------------------------------------
  // Exact unique replacement
  // -----------------------------------------------------------------------

  test('exact unique replacement', () => {
    const content = 'hello world\n';
    const result = applyEdit(content, 'hello world', 'updated', false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('updated\n');
    expect(result.matchCount).toBe(1);
    expect(result.matchMethod).toBe('exact');
    expect(result.similarity).toBe(1);
  });

  test('exact replacement in multi-line content', () => {
    const content = 'line one\nline two\nline three\n';
    const result = applyEdit(content, 'line two', 'replaced', false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('line one\nreplaced\nline three\n');
    expect(result.matchMethod).toBe('exact');
  });

  // -----------------------------------------------------------------------
  // Whitespace/fuzzy match behavior
  // -----------------------------------------------------------------------

  test('whitespace-normalized match when exact fails', () => {
    // Content has extra leading whitespace vs. the search string
    const content = '  function foo() {\n    return 1;\n  }\n';
    const oldString = 'function foo() {\n  return 1;\n}';
    const newString = 'function bar() {\n  return 2;\n}';
    const result = applyEdit(content, oldString, newString, false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchMethod).toBe('whitespace');
    expect(result.matchCount).toBe(1);
    expect(result.similarity).toBe(1);
    // The indentation should be adjusted
    expect(result.updatedContent).toContain('function bar()');
  });

  test('fuzzy match when whitespace match also fails', () => {
    // Content has a slightly different line from oldString (typo-level difference)
    const content = 'function fooo() {\n  return 1;\n}\n';
    const oldString = 'function foo() {\n  return 1;\n}';
    const newString = 'function bar() {\n  return 2;\n}';
    const result = applyEdit(content, oldString, newString, false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matchMethod).toBe('fuzzy');
    expect(result.matchCount).toBe(1);
    expect(result.similarity).toBeGreaterThan(0.8);
    expect(result.similarity).toBeLessThan(1);
  });

  // -----------------------------------------------------------------------
  // Ambiguous behavior
  // -----------------------------------------------------------------------

  test('ambiguous: returns error when old_string appears multiple times', () => {
    const content = 'repeat\nrepeat\n';
    const result = applyEdit(content, 'repeat', 'new', false);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
    if (result.reason !== 'ambiguous') return;
    expect(result.matchCount).toBe(2);
  });

  test('ambiguous: three occurrences reports correct count', () => {
    const content = 'x\nx\nx\n';
    const result = applyEdit(content, 'x', 'y', false);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
    if (result.reason !== 'ambiguous') return;
    expect(result.matchCount).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Not found
  // -----------------------------------------------------------------------

  test('not found: returns error when old_string is absent', () => {
    const content = 'hello world\n';
    const result = applyEdit(content, 'nonexistent', 'replacement', false);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  // -----------------------------------------------------------------------
  // replace_all count correctness
  // -----------------------------------------------------------------------

  test('replace_all: replaces all occurrences and reports correct count', () => {
    const content = 'x\ny\nx\nz\nx\n';
    const result = applyEdit(content, 'x', 'replaced', true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('replaced\ny\nreplaced\nz\nreplaced\n');
    expect(result.matchCount).toBe(3);
    expect(result.matchMethod).toBe('exact');
    expect(result.similarity).toBe(1);
  });

  test('replace_all: single occurrence reports count of 1', () => {
    const content = 'a b c\n';
    const result = applyEdit(content, 'b', 'B', true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updatedContent).toBe('a B c\n');
    expect(result.matchCount).toBe(1);
  });

  test('replace_all: not found returns error', () => {
    const content = 'hello world\n';
    const result = applyEdit(content, 'missing', 'nope', true);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_found');
  });

  // -----------------------------------------------------------------------
  // Executor preview parity: same engine, same output
  // -----------------------------------------------------------------------

  test('executor preview parity: computed preview matches actual edit output', () => {
    // Simulate what both the executor preview and tool execution do:
    // both call applyEdit with the same inputs and should get identical results.
    const content = 'function hello() {\n  console.log("hi");\n}\n';
    const oldString = 'console.log("hi")';
    const newString = 'console.log("bye")';

    // "Preview" call (what computePreviewDiff does)
    const preview = applyEdit(content, oldString, newString, false);
    // "Execution" call (what the edit tool does)
    const execution = applyEdit(content, oldString, newString, false);

    expect(preview.ok).toBe(true);
    expect(execution.ok).toBe(true);
    if (!preview.ok || !execution.ok) return;

    expect(preview.updatedContent).toBe(execution.updatedContent);
    expect(preview.matchCount).toBe(execution.matchCount);
    expect(preview.matchMethod).toBe(execution.matchMethod);
  });

  test('executor preview parity: replace_all mode', () => {
    const content = 'TODO\nsome code\nTODO\n';
    const oldString = 'TODO';
    const newString = 'DONE';

    const preview = applyEdit(content, oldString, newString, true);
    const execution = applyEdit(content, oldString, newString, true);

    expect(preview.ok).toBe(true);
    expect(execution.ok).toBe(true);
    if (!preview.ok || !execution.ok) return;

    expect(preview.updatedContent).toBe(execution.updatedContent);
    expect(preview.matchCount).toBe(execution.matchCount);
  });
});
