import { describe, test, expect } from 'bun:test';
import { executeSwarm } from '../swarm/orchestrator.js';
import type { OrchestratorEvent } from '../swarm/orchestrator.js';
import type { SwarmPlan } from '../swarm/types.js';
import type { SwarmWorkerBackend } from '../swarm/worker-backend.js';
import { resolveSwarmLimits } from '../swarm/limits.js';

const DEFAULT_LIMITS = resolveSwarmLimits({
  maxWorkers: 3,
  maxTasks: 8,
  maxRetriesPerTask: 1,
  workerTimeoutSec: 900,
});

function makeBackend(overrides?: Partial<SwarmWorkerBackend>): SwarmWorkerBackend {
  return {
    name: 'test-backend',
    isAvailable: () => true,
    runTask: async () => ({
      success: true,
      output: '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
      durationMs: 50,
    }),
    ...overrides,
  };
}

function makePlan(overrides?: Partial<SwarmPlan>): SwarmPlan {
  return {
    objective: 'Test objective',
    tasks: [
      { id: 'task-1', role: 'coder', objective: 'Do task 1', dependencies: [] },
    ],
    ...overrides,
  };
}

describe('executeSwarm', () => {
  test('executes a single-task plan successfully', async () => {
    const summary = await executeSwarm({
      plan: makePlan(),
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });

    expect(summary.stats.totalTasks).toBe(1);
    expect(summary.stats.completed).toBe(1);
    expect(summary.stats.failed).toBe(0);
    expect(summary.stats.blocked).toBe(0);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].status).toBe('completed');
    expect(summary.finalAnswer).toContain('task-1');
  });

  test('executes parallel independent tasks', async () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: [] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: [] },
      ],
    });

    const summary = await executeSwarm({
      plan,
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });

    expect(summary.stats.completed).toBe(2);
    expect(summary.stats.failed).toBe(0);
  });

  test('executes sequential tasks in dependency order', async () => {
    const executionOrder: string[] = [];
    const plan = makePlan({
      tasks: [
        { id: 'research', role: 'researcher', objective: 'Research', dependencies: [] },
        { id: 'code', role: 'coder', objective: 'Code', dependencies: ['research'] },
        { id: 'review', role: 'reviewer', objective: 'Review', dependencies: ['code'] },
      ],
    });

    const backend = makeBackend({
      runTask: async (input) => {
        // Extract task id from prompt
        const match = input.prompt.match(/researcher|coder|reviewer/);
        if (match) executionOrder.push(match[0]);
        return {
          success: true,
          output: '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
          durationMs: 10,
        };
      },
    });

    const summary = await executeSwarm({
      plan,
      limits: DEFAULT_LIMITS,
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.completed).toBe(3);
    expect(executionOrder).toEqual(['researcher', 'coder', 'reviewer']);
  });

  test('blocks dependents when a task fails', async () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: [] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: ['a'] },
        { id: 'c', role: 'coder', objective: 'C', dependencies: ['b'] },
      ],
    });

    const backend = makeBackend({
      runTask: async () => ({
        success: false,
        output: 'Failed',
        failureReason: 'timeout',
        durationMs: 10,
      }),
    });

    const summary = await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...DEFAULT_LIMITS, maxRetriesPerTask: 0 }),
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.failed).toBe(1);
    expect(summary.stats.blocked).toBe(2);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].taskId).toBe('a');
  });

  test('retries failed tasks up to maxRetriesPerTask', async () => {
    let callCount = 0;
    const plan = makePlan();

    const backend = makeBackend({
      runTask: async () => {
        callCount++;
        if (callCount <= 1) {
          return { success: false, output: 'fail', failureReason: 'timeout' as const, durationMs: 10 };
        }
        return {
          success: true,
          output: '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
          durationMs: 10,
        };
      },
    });

    const summary = await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...DEFAULT_LIMITS, maxRetriesPerTask: 2 }),
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.completed).toBe(1);
    expect(summary.results[0].retryCount).toBe(1);
  });

  test('emits orchestrator events', async () => {
    const events: OrchestratorEvent[] = [];
    const plan = makePlan();

    await executeSwarm({
      plan,
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
      onStatus: (event) => events.push(event),
    });

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('plan_created');
    expect(kinds).toContain('task_started');
    expect(kinds).toContain('task_completed');
    expect(kinds).toContain('synthesis_started');
    expect(kinds).toContain('done');
  });

  test('uses fallback markdown when no synthesis provider given', async () => {
    const summary = await executeSwarm({
      plan: makePlan(),
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });

    expect(summary.finalAnswer).toContain('Swarm Results');
    expect(summary.finalAnswer).toContain('task-1');
  });

  test('reports totalDurationMs', async () => {
    const summary = await executeSwarm({
      plan: makePlan(),
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });

    expect(summary.stats.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('uses markdown fallback when aborted without synthesis provider', async () => {
    const controller = new AbortController();
    let taskRun = false;
    const backend = makeBackend({
      runTask: async () => {
        taskRun = true;
        // Abort after the first task completes
        controller.abort();
        return {
          success: true,
          output: '```json\n{"summary":"Partial work done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
          durationMs: 10,
        };
      },
    });

    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: [] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: ['a'] },
      ],
    });

    const summary = await executeSwarm({
      plan,
      limits: DEFAULT_LIMITS,
      backend,
      workingDir: '/tmp',
      signal: controller.signal,
    });

    expect(taskRun).toBe(true);
    // Should use markdown fallback with partial results, not a fixed cancellation string
    expect(summary.finalAnswer).toContain('Swarm Results');
    expect(summary.finalAnswer).toContain('a');
    expect(summary.finalAnswer).not.toContain('cancelled');
  });

  test('handles diamond dependency pattern', async () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: [] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: ['a'] },
        { id: 'c', role: 'coder', objective: 'C', dependencies: ['a'] },
        { id: 'd', role: 'coder', objective: 'D', dependencies: ['b', 'c'] },
      ],
    });

    const summary = await executeSwarm({
      plan,
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });

    expect(summary.stats.completed).toBe(4);
    expect(summary.stats.blocked).toBe(0);
  });

  test('schedules dependents eagerly without waiting for batch peers', async () => {
    // A (slow) and B (fast) are independent. C depends only on B.
    // With eager scheduling, C should start while A is still running.
    const timeline: { taskId: string; event: 'start' | 'end' }[] = [];

    const plan = makePlan({
      tasks: [
        { id: 'A', role: 'coder', objective: 'slow', dependencies: [] },
        { id: 'B', role: 'coder', objective: 'fast', dependencies: [] },
        { id: 'C', role: 'coder', objective: 'dep-on-B', dependencies: ['B'] },
      ],
    });

    const backend = makeBackend({
      runTask: async (input) => {
        const id = input.prompt.includes('slow') ? 'A'
          : input.prompt.includes('fast') ? 'B' : 'C';
        timeline.push({ taskId: id, event: 'start' });
        // A is deliberately slower than B so C should start before A finishes
        if (id === 'A') await new Promise((r) => setTimeout(r, 80));
        else await new Promise((r) => setTimeout(r, 5));
        timeline.push({ taskId: id, event: 'end' });
        return {
          success: true,
          output: '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
          durationMs: 10,
        };
      },
    });

    const summary = await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...DEFAULT_LIMITS, maxWorkers: 3 }),
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.completed).toBe(3);

    // C must start before A ends — proves eager scheduling
    const cStart = timeline.findIndex((e) => e.taskId === 'C' && e.event === 'start');
    const aEnd = timeline.findIndex((e) => e.taskId === 'A' && e.event === 'end');
    expect(cStart).toBeGreaterThan(-1);
    expect(aEnd).toBeGreaterThan(-1);
    expect(cStart).toBeLessThan(aEnd);
  });
});
