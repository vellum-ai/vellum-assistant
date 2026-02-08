import { describe, expect, test } from 'bun:test';
import { findMatch, findAllMatches, adjustIndentation } from '../tools/filesystem/fuzzy-match.js';

describe('findMatch', () => {
  test('exact match returns method "exact"', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const target = 'return "world";';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('exact');
    expect(result!.similarity).toBe(1);
    expect(result!.matched).toBe('return "world";');
  });

  test('whitespace normalization: 2-space indent matches 4-space', () => {
    const content = '    function hello() {\n        return "world";\n    }';
    const target = '  function hello() {\n    return "world";\n  }';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('whitespace');
    expect(result!.matched).toBe('    function hello() {\n        return "world";\n    }');
  });

  test('tabs vs spaces: tab-indented target matches space-indented file', () => {
    const content = '    const x = 1;\n    const y = 2;';
    const target = '\tconst x = 1;\n\tconst y = 2;';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('whitespace');
  });

  test('trailing whitespace: target with trailing spaces matches file without', () => {
    const content = 'const x = 1;\nconst y = 2;';
    const target = 'const x = 1;   \nconst y = 2;  ';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('whitespace');
  });

  test('fuzzy match: minor typo matches with method "fuzzy"', () => {
    const content = 'const value = 42;\nconst other = 10;';
    const target = 'cosnt value = 42;\nconst other = 10;';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('fuzzy');
    expect(result!.similarity).toBeGreaterThanOrEqual(0.8);
  });

  test('no match: completely different string returns null', () => {
    const content = 'function hello() {\n  return "world";\n}';
    const target = 'class Foo extends Bar {\n  constructor() {}\n}';
    const result = findMatch(content, target);
    expect(result).toBeNull();
  });

  test('below threshold: similarity too low returns null', () => {
    const content = 'abcdefghij';
    const target = 'zyxwvutsrq';
    const result = findMatch(content, target);
    expect(result).toBeNull();
  });

  test('prefers exact match over whitespace match', () => {
    const content = '  const x = 1;';
    const target = '  const x = 1;';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('exact');
  });

  test('single-line whitespace match', () => {
    const content = 'if (x) {\n    return true;\n}';
    const target = '\treturn true;';
    const result = findMatch(content, target);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('whitespace');
    expect(result!.matched).toBe('    return true;');
  });
});

describe('findAllMatches', () => {
  test('returns multiple exact matches', () => {
    const content = 'foo bar foo baz foo';
    const target = 'foo';
    const results = findAllMatches(content, target);
    expect(results.length).toBe(3);
    results.forEach(r => expect(r.method).toBe('exact'));
  });

  test('returns multiple whitespace matches', () => {
    const content = 'begin\n    const x = 1;\nmiddle\n    const x = 1;\nend';
    const target = '\tconst x = 1;';
    const results = findAllMatches(content, target);
    expect(results.length).toBe(2);
    results.forEach(r => expect(r.method).toBe('whitespace'));
  });

  test('returns empty array for no match', () => {
    const content = 'hello world';
    const target = 'goodbye universe';
    const results = findAllMatches(content, target);
    expect(results.length).toBe(0);
  });
});

describe('adjustIndentation', () => {
  test('adds indentation when file has more than old_string', () => {
    const oldString = '  function foo() {\n    return 1;\n  }';
    const matched = '    function foo() {\n      return 1;\n    }';
    const newString = '  function foo() {\n    return 2;\n  }';
    const result = adjustIndentation(oldString, matched, newString);
    expect(result).toBe('    function foo() {\n      return 2;\n    }');
  });

  test('removes indentation when file has less than old_string', () => {
    const oldString = '    function foo() {\n      return 1;\n    }';
    const matched = '  function foo() {\n    return 1;\n  }';
    const newString = '    function foo() {\n      return 2;\n    }';
    const result = adjustIndentation(oldString, matched, newString);
    expect(result).toBe('  function foo() {\n    return 2;\n  }');
  });

  test('no change when indentation matches', () => {
    const oldString = '  return 1;';
    const matched = '  return 1;';
    const newString = '  return 2;';
    const result = adjustIndentation(oldString, matched, newString);
    expect(result).toBe('  return 2;');
  });

  test('preserves empty lines', () => {
    const oldString = '  const a = 1;\n\n  const b = 2;';
    const matched = '    const a = 1;\n\n    const b = 2;';
    const newString = '  const a = 10;\n\n  const b = 20;';
    const result = adjustIndentation(oldString, matched, newString);
    expect(result).toBe('    const a = 10;\n\n    const b = 20;');
  });
});
