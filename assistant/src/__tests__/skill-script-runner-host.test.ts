import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillToolScript } from '../tools/skills/skill-script-runner.js';
import type { ToolContext } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp',
    sessionId: 'test-session',
    conversationId: 'test-conversation',
    ...overrides,
  };
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'skill-script-runner-test-'));

  // Write test script files that the runner will dynamically import.

  // 1. A script that successfully returns a result.
  await writeFile(
    join(tempDir, 'success.ts'),
    `export async function run(input, context) {
  return { content: 'hello from ' + input.name, isError: false };
}`,
    'utf-8',
  );

  // 2. A script that does NOT export a run function.
  await writeFile(
    join(tempDir, 'no-run.ts'),
    `export const version = 1;`,
    'utf-8',
  );

  // 3. A script whose run function throws an error.
  await writeFile(
    join(tempDir, 'throws.ts'),
    `export async function run() {
  throw new Error('intentional kaboom');
}`,
    'utf-8',
  );

  // 4. A script that returns the input and context for inspection.
  await writeFile(
    join(tempDir, 'echo.ts'),
    `export async function run(input, context) {
  return {
    content: JSON.stringify({ input, workingDir: context.workingDir, sessionId: context.sessionId }),
    isError: false,
  };
}`,
    'utf-8',
  );
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

describe('runSkillToolScript — success', () => {
  test('executes a valid script and returns its result', async () => {
    const result = await runSkillToolScript(tempDir, 'success.ts', { name: 'world' }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello from world');
  });

  test('passes input and context through to the script', async () => {
    const ctx = makeContext({ workingDir: '/my/project', sessionId: 'sess-42' });
    const result = await runSkillToolScript(tempDir, 'echo.ts', { foo: 'bar' }, ctx);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.input).toEqual({ foo: 'bar' });
    expect(parsed.workingDir).toBe('/my/project');
    expect(parsed.sessionId).toBe('sess-42');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('runSkillToolScript — errors', () => {
  test('returns error result when script does not export a run function', async () => {
    const result = await runSkillToolScript(tempDir, 'no-run.ts', {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('does not export a "run" function');
    expect(result.content).toContain('no-run.ts');
  });

  test('returns error result when script throws during execution', async () => {
    const result = await runSkillToolScript(tempDir, 'throws.ts', {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('threw an error');
    expect(result.content).toContain('intentional kaboom');
    expect(result.content).toContain('throws.ts');
  });

  test('returns error result when script file does not exist', async () => {
    const result = await runSkillToolScript(tempDir, 'nonexistent.ts', {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to load skill tool script');
    expect(result.content).toContain('nonexistent.ts');
  });
});
