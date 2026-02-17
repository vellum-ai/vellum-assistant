import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillToolScript } from '../tools/skills/skill-script-runner.js';
import type { RunSkillToolScriptOptions } from '../tools/skills/skill-script-runner.js';
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

  test('rejects executor paths that escape the skill directory via ../', async () => {
    const result = await runSkillToolScript(tempDir, '../../etc/passwd', {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes the skill directory');
  });

  test('rejects executor paths that escape via intermediate ../ segments', async () => {
    const result = await runSkillToolScript(tempDir, 'sub/../../outside.ts', {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('escapes the skill directory');
  });
});

// ---------------------------------------------------------------------------
// Host skill runner hash guard
// ---------------------------------------------------------------------------

describe('runSkillToolScript — host hash guard', () => {
  test('allows execution when no expectedSkillVersionHash is provided', async () => {
    const result = await runSkillToolScript(tempDir, 'success.ts', { name: 'world' }, makeContext());

    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello from world');
  });

  test('allows execution when hash matches', async () => {
    const expectedHash = 'v1:matching-hash';
    const resolver = (_dir: string) => expectedHash;

    const result = await runSkillToolScript(tempDir, 'success.ts', { name: 'world' }, makeContext(), {
      expectedSkillVersionHash: expectedHash,
      skillDirHashResolver: resolver,
    });

    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello from world');
  });

  test('blocks execution when hash mismatches', async () => {
    const expectedHash = 'v1:approved-hash';
    const currentHash = 'v1:modified-hash';
    const resolver = (_dir: string) => currentHash;

    const result = await runSkillToolScript(tempDir, 'success.ts', { name: 'world' }, makeContext(), {
      expectedSkillVersionHash: expectedHash,
      skillDirHashResolver: resolver,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Skill version mismatch');
    expect(result.content).toContain(expectedHash);
    expect(result.content).toContain(currentHash);
    expect(result.content).toContain('Please reload the skill to re-approve');
  });

  test('mismatch error is non-throwing and user-readable', async () => {
    const resolver = (_dir: string) => 'v1:different';

    const result = await runSkillToolScript(tempDir, 'success.ts', {}, makeContext(), {
      expectedSkillVersionHash: 'v1:original',
      skillDirHashResolver: resolver,
    });

    // Should return a structured error result, not throw.
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('isError', true);
    expect(result.content).toContain('modified since it was approved');
  });

  test('uses computeSkillVersionHash by default when no resolver is provided', async () => {
    // When expectedSkillVersionHash is set but no resolver is given, the runner
    // falls back to the real computeSkillVersionHash. Since the temp dir content
    // almost certainly won't match a fabricated hash, this should block.
    const result = await runSkillToolScript(tempDir, 'success.ts', {}, makeContext(), {
      expectedSkillVersionHash: 'v1:definitely-not-a-real-hash',
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Skill version mismatch');
  });

  test('passes the resolved skill directory to the hash resolver', async () => {
    let receivedDir: string | undefined;
    const resolver = (dir: string) => {
      receivedDir = dir;
      return 'v1:match';
    };

    await runSkillToolScript(tempDir, 'success.ts', {}, makeContext(), {
      expectedSkillVersionHash: 'v1:match',
      skillDirHashResolver: resolver,
    });

    // The resolver should receive the resolved skill directory with trailing slash.
    expect(receivedDir).toBeDefined();
    expect(receivedDir!.endsWith('/')).toBe(true);
  });

  test('RunSkillToolScriptOptions type accepts all fields', () => {
    const options: RunSkillToolScriptOptions = {
      target: 'host',
      timeoutMs: 5000,
      expectedSkillVersionHash: 'v1:deadbeef',
      skillDirHashResolver: (dir: string) => `v1:hash-of-${dir}`,
    };

    expect(options.expectedSkillVersionHash).toBe('v1:deadbeef');
    expect(options.skillDirHashResolver).toBeInstanceOf(Function);
    expect(options.skillDirHashResolver!('/some/dir')).toBe('v1:hash-of-/some/dir');
  });
});

// ---------------------------------------------------------------------------
// Tamper regression: end-to-end hash guard lifecycle
// ---------------------------------------------------------------------------

describe('runSkillToolScript — tamper regression lifecycle', () => {
  test('execution succeeds with matching hash, fails after tamper, succeeds after re-approval', async () => {
    // Simulates the full lifecycle:
    // 1. Tool approved with hash A — execution succeeds
    // 2. File tampered (hash changes to B) — execution blocked
    // 3. Skill reloaded (re-approved with hash B) — execution succeeds again

    let currentDiskHash = 'v1:approved-hash-aaa';
    const resolver = (_dir: string) => currentDiskHash;

    // Phase 1: hash matches approved hash — execution succeeds
    const result1 = await runSkillToolScript(tempDir, 'success.ts', { name: 'phase1' }, makeContext(), {
      expectedSkillVersionHash: 'v1:approved-hash-aaa',
      skillDirHashResolver: resolver,
    });
    expect(result1.isError).toBe(false);
    expect(result1.content).toBe('hello from phase1');

    // Phase 2: file tampered on disk — hash drifts
    currentDiskHash = 'v1:tampered-hash-bbb';

    const result2 = await runSkillToolScript(tempDir, 'success.ts', { name: 'phase2' }, makeContext(), {
      expectedSkillVersionHash: 'v1:approved-hash-aaa', // still using old approval
      skillDirHashResolver: resolver,
    });
    expect(result2.isError).toBe(true);
    expect(result2.content).toContain('Skill version mismatch');
    expect(result2.content).toContain('v1:approved-hash-aaa');
    expect(result2.content).toContain('v1:tampered-hash-bbb');

    // Phase 3: skill reloaded — now approved with the new hash
    const result3 = await runSkillToolScript(tempDir, 'success.ts', { name: 'phase3' }, makeContext(), {
      expectedSkillVersionHash: 'v1:tampered-hash-bbb', // updated approval
      skillDirHashResolver: resolver,
    });
    expect(result3.isError).toBe(false);
    expect(result3.content).toBe('hello from phase3');
  });

  test('multiple sequential tampers each block until re-approved', async () => {
    let currentDiskHash = 'v1:version-1';
    const resolver = (_dir: string) => currentDiskHash;

    // Approved at version-1
    let approvedHash = 'v1:version-1';

    // Execute successfully with version-1
    const r1 = await runSkillToolScript(tempDir, 'success.ts', { name: 'v1' }, makeContext(), {
      expectedSkillVersionHash: approvedHash,
      skillDirHashResolver: resolver,
    });
    expect(r1.isError).toBe(false);

    // First tamper to version-2
    currentDiskHash = 'v1:version-2';
    const r2 = await runSkillToolScript(tempDir, 'success.ts', { name: 'v2' }, makeContext(), {
      expectedSkillVersionHash: approvedHash,
      skillDirHashResolver: resolver,
    });
    expect(r2.isError).toBe(true);
    expect(r2.content).toContain('Skill version mismatch');

    // Re-approve at version-2
    approvedHash = 'v1:version-2';
    const r2ok = await runSkillToolScript(tempDir, 'success.ts', { name: 'v2' }, makeContext(), {
      expectedSkillVersionHash: approvedHash,
      skillDirHashResolver: resolver,
    });
    expect(r2ok.isError).toBe(false);

    // Second tamper to version-3
    currentDiskHash = 'v1:version-3';
    const r3 = await runSkillToolScript(tempDir, 'success.ts', { name: 'v3' }, makeContext(), {
      expectedSkillVersionHash: approvedHash,
      skillDirHashResolver: resolver,
    });
    expect(r3.isError).toBe(true);
    expect(r3.content).toContain('Skill version mismatch');

    // Re-approve at version-3
    approvedHash = 'v1:version-3';
    const r3ok = await runSkillToolScript(tempDir, 'success.ts', { name: 'v3' }, makeContext(), {
      expectedSkillVersionHash: approvedHash,
      skillDirHashResolver: resolver,
    });
    expect(r3ok.isError).toBe(false);
    expect(r3ok.content).toBe('hello from v3');
  });

  test('tamper blocks execution even for different executor scripts in the same skill', async () => {
    let currentDiskHash = 'v1:skill-hash-ok';
    const resolver = (_dir: string) => currentDiskHash;

    // Both scripts work when hash matches
    const r1 = await runSkillToolScript(tempDir, 'success.ts', { name: 'a' }, makeContext(), {
      expectedSkillVersionHash: 'v1:skill-hash-ok',
      skillDirHashResolver: resolver,
    });
    expect(r1.isError).toBe(false);

    const r2 = await runSkillToolScript(tempDir, 'echo.ts', { key: 'val' }, makeContext(), {
      expectedSkillVersionHash: 'v1:skill-hash-ok',
      skillDirHashResolver: resolver,
    });
    expect(r2.isError).toBe(false);

    // Tamper the skill directory
    currentDiskHash = 'v1:skill-hash-tampered';

    // Both scripts are blocked
    const r3 = await runSkillToolScript(tempDir, 'success.ts', { name: 'b' }, makeContext(), {
      expectedSkillVersionHash: 'v1:skill-hash-ok',
      skillDirHashResolver: resolver,
    });
    expect(r3.isError).toBe(true);
    expect(r3.content).toContain('Skill version mismatch');

    const r4 = await runSkillToolScript(tempDir, 'echo.ts', { key: 'val2' }, makeContext(), {
      expectedSkillVersionHash: 'v1:skill-hash-ok',
      skillDirHashResolver: resolver,
    });
    expect(r4.isError).toBe(true);
    expect(r4.content).toContain('Skill version mismatch');
  });

  test('error message instructs user to reload the skill', async () => {
    const resolver = (_dir: string) => 'v1:changed';

    const result = await runSkillToolScript(tempDir, 'success.ts', {}, makeContext(), {
      expectedSkillVersionHash: 'v1:original',
      skillDirHashResolver: resolver,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Please reload the skill to re-approve');
    expect(result.content).toContain('modified since it was approved');
  });
});
