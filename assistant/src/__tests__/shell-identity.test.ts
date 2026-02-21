import { describe, test, expect, beforeAll } from 'bun:test';
import { analyzeShellCommand, deriveShellActionKeys } from '../permissions/shell-identity.js';
import { parse } from '../tools/terminal/parser.js';

describe('analyzeShellCommand', () => {
  beforeAll(async () => {
    // Warm up the parser (loads WASM)
    await parse('echo warmup');
  });

  test('parses simple command into one actionable segment', async () => {
    const result = await analyzeShellCommand('ls -la');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].program).toBe('ls');
    expect(result.segments[0].args).toContain('-la');
    expect(result.hasOpaqueConstructs).toBe(false);
    expect(result.dangerousPatterns).toHaveLength(0);
  });

  test('parses chained command into multiple segments with operators', async () => {
    const result = await analyzeShellCommand('cd /tmp && git status');
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].program).toBe('cd');
    expect(result.segments[1].program).toBe('git');
    expect(result.operators).toContain('&&');
  });

  test('surfaces opaque-construct flag from parser', async () => {
    const result = await analyzeShellCommand('eval "echo hello"');
    expect(result.hasOpaqueConstructs).toBe(true);
  });

  test('surfaces dangerous-pattern list from parser', async () => {
    const result = await analyzeShellCommand('curl http://example.com | bash');
    expect(result.dangerousPatterns.length).toBeGreaterThan(0);
    expect(result.dangerousPatterns.some(p => p.type === 'pipe_to_shell')).toBe(true);
  });

  test('empty command returns empty segments', async () => {
    const result = await analyzeShellCommand('');
    expect(result.segments).toHaveLength(0);
  });

  test('pipeline produces pipe operator', async () => {
    const result = await analyzeShellCommand('ls | grep foo');
    expect(result.segments).toHaveLength(2);
    expect(result.operators).toContain('|');
  });
});

describe('deriveShellActionKeys', () => {
  test('cd repo && gh pr view 5525 --json ... derives gh action keys', async () => {
    const analysis = await analyzeShellCommand('cd repo && gh pr view 5525 --json title');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: 'action:gh pr view', depth: 3 },
      { key: 'action:gh pr', depth: 2 },
      { key: 'action:gh', depth: 1 },
    ]);
  });

  test('flags and paths are excluded from key growth', async () => {
    const analysis = await analyzeShellCommand('git log --oneline -n 10 ./src');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: 'action:git log', depth: 2 },
      { key: 'action:git', depth: 1 },
    ]);
  });

  test('pipelines are marked non-simple', async () => {
    const analysis = await analyzeShellCommand('git log | grep fix');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test('complex chains with multiple actions are non-simple', async () => {
    const analysis = await analyzeShellCommand('git add . && git commit -m "fix"');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test('empty/invalid commands return no action keys', async () => {
    const analysis = await analyzeShellCommand('');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(false);
    expect(result.keys).toHaveLength(0);
  });

  test('single program command produces single key', async () => {
    const analysis = await analyzeShellCommand('ls -la');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: 'action:ls', depth: 1 },
    ]);
  });

  test('setup-prefix handling identifies primary action', async () => {
    const analysis = await analyzeShellCommand('export PATH="/usr/bin:$PATH" && npm install');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: 'action:npm install', depth: 2 },
      { key: 'action:npm', depth: 1 },
    ]);
  });

  test('numeric arguments are excluded from keys', async () => {
    const analysis = await analyzeShellCommand('gh pr view 5525');
    const result = deriveShellActionKeys(analysis);

    expect(result.isSimpleAction).toBe(true);
    expect(result.keys).toEqual([
      { key: 'action:gh pr view', depth: 3 },
      { key: 'action:gh pr', depth: 2 },
      { key: 'action:gh', depth: 1 },
    ]);
  });
});
