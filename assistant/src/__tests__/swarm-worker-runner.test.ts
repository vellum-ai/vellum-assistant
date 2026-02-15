import { describe, test, expect, mock } from 'bun:test';
import { runWorkerTask } from '../swarm/worker-runner.js';
import { parseWorkerOutput, buildWorkerPrompt } from '../swarm/worker-prompts.js';
import type { SwarmWorkerBackend, SwarmWorkerBackendInput } from '../swarm/worker-backend.js';
import type { SwarmTaskNode } from '../swarm/types.js';
import type { WorkerStatusKind } from '../swarm/worker-runner.js';

function makeTask(overrides?: Partial<SwarmTaskNode>): SwarmTaskNode {
  return {
    id: 'test-task',
    role: 'coder',
    objective: 'Write a function',
    dependencies: [],
    ...overrides,
  };
}

function makeBackend(overrides?: Partial<SwarmWorkerBackend>): SwarmWorkerBackend {
  return {
    name: 'test-backend',
    isAvailable: () => true,
    runTask: async () => ({
      success: true,
      output: '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
      durationMs: 100,
    }),
    ...overrides,
  };
}

describe('runWorkerTask', () => {
  test('returns completed result on success', async () => {
    const result = await runWorkerTask({
      task: makeTask(),
      backend: makeBackend(),
      workingDir: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.status).toBe('completed');
    expect(result.taskId).toBe('test-task');
    expect(result.summary).toBe('Done');
    expect(result.durationMs).toBe(100);
  });

  test('returns failed result when backend is unavailable', async () => {
    const result = await runWorkerTask({
      task: makeTask(),
      backend: makeBackend({ isAvailable: () => false }),
      workingDir: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.status).toBe('failed');
    expect(result.issues[0]).toContain('unavailable');
  });

  test('returns failed result when backend returns failure', async () => {
    const result = await runWorkerTask({
      task: makeTask(),
      backend: makeBackend({
        runTask: async () => ({
          success: false,
          output: 'Something went wrong',
          failureReason: 'timeout',
          durationMs: 900,
        }),
      }),
      workingDir: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.status).toBe('failed');
    expect(result.issues).toContain('timeout');
    expect(result.durationMs).toBe(900);
  });

  test('returns failed result when backend throws', async () => {
    const result = await runWorkerTask({
      task: makeTask(),
      backend: makeBackend({
        runTask: async () => { throw new Error('Boom'); },
      }),
      workingDir: '/tmp',
      timeoutMs: 5000,
    });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Boom');
  });

  test('emits status callbacks in order', async () => {
    const statuses: WorkerStatusKind[] = [];
    await runWorkerTask({
      task: makeTask(),
      backend: makeBackend(),
      workingDir: '/tmp',
      timeoutMs: 5000,
      onStatus: (_taskId, status) => statuses.push(status),
    });
    expect(statuses).toEqual(['queued', 'running', 'completed']);
  });

  test('emits queued then failed when backend unavailable', async () => {
    const statuses: WorkerStatusKind[] = [];
    await runWorkerTask({
      task: makeTask(),
      backend: makeBackend({ isAvailable: () => false }),
      workingDir: '/tmp',
      timeoutMs: 5000,
      onStatus: (_taskId, status) => statuses.push(status),
    });
    expect(statuses).toEqual(['queued', 'failed']);
  });

  test('continues execution when onStatus callback throws', async () => {
    const result = await runWorkerTask({
      task: makeTask(),
      backend: makeBackend(),
      workingDir: '/tmp',
      timeoutMs: 5000,
      onStatus: () => {
        throw new Error('status callback failed');
      },
    });
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Done');
  });

  test('maps role to correct profile in prompt', async () => {
    let capturedInput: SwarmWorkerBackendInput | null = null;
    await runWorkerTask({
      task: makeTask({ role: 'researcher' }),
      backend: makeBackend({
        runTask: async (input) => {
          capturedInput = input;
          return { success: true, output: 'ok', durationMs: 50 };
        },
      }),
      workingDir: '/tmp',
      timeoutMs: 5000,
    });
    expect(capturedInput!.profile).toBe('researcher');
  });

  test('includes dependency outputs in prompt', async () => {
    let capturedInput: SwarmWorkerBackendInput | null = null;
    await runWorkerTask({
      task: makeTask(),
      dependencyOutputs: [{ taskId: 'dep-1', summary: 'Research complete' }],
      backend: makeBackend({
        runTask: async (input) => {
          capturedInput = input;
          return { success: true, output: 'ok', durationMs: 50 };
        },
      }),
      workingDir: '/tmp',
      timeoutMs: 5000,
    });
    expect(capturedInput!.prompt).toContain('dep-1');
    expect(capturedInput!.prompt).toContain('Research complete');
  });
});

describe('parseWorkerOutput', () => {
  test('parses valid fenced JSON', () => {
    const raw = 'Some preamble\n```json\n{"summary":"Done","artifacts":["file.ts"],"issues":[],"nextSteps":["test"]}\n```\nSome epilogue';
    const result = parseWorkerOutput(raw);
    expect(result.summary).toBe('Done');
    expect(result.artifacts).toEqual(['file.ts']);
    expect(result.nextSteps).toEqual(['test']);
  });

  test('falls back to raw summary on invalid JSON', () => {
    const raw = '```json\n{invalid json}\n```';
    const result = parseWorkerOutput(raw);
    expect(result.summary).toBe(raw.slice(0, 500));
    expect(result.artifacts).toEqual([]);
  });

  test('falls back to raw summary when no JSON block', () => {
    const raw = 'Just a plain text output without any JSON.';
    const result = parseWorkerOutput(raw);
    expect(result.summary).toBe(raw);
    expect(result.artifacts).toEqual([]);
  });

  test('truncates long raw output to 500 chars', () => {
    const raw = 'x'.repeat(1000);
    const result = parseWorkerOutput(raw);
    expect(result.summary.length).toBe(500);
  });

  test('uses the final fenced JSON block when multiple are present', () => {
    const raw = [
      '```json',
      '{"summary":"intermediate","artifacts":["a.ts"],"issues":[],"nextSteps":[]}',
      '```',
      '',
      '```json',
      '{"summary":"final","artifacts":["b.ts"],"issues":["warn"],"nextSteps":["ship"]}',
      '```',
    ].join('\n');
    const result = parseWorkerOutput(raw);
    expect(result.summary).toBe('final');
    expect(result.artifacts).toEqual(['b.ts']);
    expect(result.issues).toEqual(['warn']);
    expect(result.nextSteps).toEqual(['ship']);
  });
});

describe('buildWorkerPrompt', () => {
  test('includes role and objective', () => {
    const prompt = buildWorkerPrompt({ role: 'coder', objective: 'Build feature X' });
    expect(prompt).toContain('coder');
    expect(prompt).toContain('Build feature X');
  });

  test('includes upstream context when provided', () => {
    const prompt = buildWorkerPrompt({
      role: 'coder',
      objective: 'Build it',
      upstreamContext: 'This is a React project',
    });
    expect(prompt).toContain('This is a React project');
  });

  test('includes dependency outputs when provided', () => {
    const prompt = buildWorkerPrompt({
      role: 'coder',
      objective: 'Build it',
      dependencyOutputs: [
        { taskId: 'research', summary: 'Found the API docs' },
      ],
    });
    expect(prompt).toContain('research');
    expect(prompt).toContain('Found the API docs');
  });

  test('includes output contract instructions', () => {
    const prompt = buildWorkerPrompt({ role: 'coder', objective: 'Test' });
    expect(prompt).toContain('```json');
    expect(prompt).toContain('summary');
  });
});
