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

  test('abort waits for in-flight workers before emitting done', async () => {
    const events: OrchestratorEvent[] = [];
    const controller = new AbortController();

    const plan = makePlan({
      tasks: [
        { id: 'fast', role: 'coder', objective: 'fast', dependencies: [] },
        { id: 'slow', role: 'coder', objective: 'slow', dependencies: [] },
      ],
    });

    const backend = makeBackend({
      runTask: async (input) => {
        if (input.prompt.includes('fast')) {
          // Fast task finishes quickly and triggers abort
          await new Promise((r) => setTimeout(r, 5));
          controller.abort();
        } else {
          // Slow task is still running when abort fires
          await new Promise((r) => setTimeout(r, 80));
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
      limits: resolveSwarmLimits({ ...DEFAULT_LIMITS, maxWorkers: 2 }),
      backend,
      workingDir: '/tmp',
      onStatus: (event) => events.push(event),
      signal: controller.signal,
    });

    const doneIdx = events.findIndex((e) => e.kind === 'done');
    const lastCompletedIdx = events.reduce(
      (max, e, i) => (e.kind === 'task_completed' ? i : max), -1,
    );

    // done must come after all task_completed events
    expect(doneIdx).toBeGreaterThan(-1);
    expect(lastCompletedIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(lastCompletedIdx);

    // Both tasks should have completed (in-flight worker was waited on)
    expect(summary.stats.completed).toBe(2);
  });

  test('does not deadlock when onStatus callback throws on task_started', async () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: [] },
      ],
    });

    // The onStatus callback throws on task_started, which happens inside
    // runTask before the worker runs. The .finally() guard on the
    // fire-and-forget promise should prevent a deadlock.
    const summary = await executeSwarm({
      plan,
      limits: DEFAULT_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
      onStatus: (event) => {
        if (event.kind === 'task_started') throw new Error('boom');
      },
    });

    // The swarm should still complete (via the .finally guard) rather than hang
    expect(summary.stats.totalTasks).toBe(1);
  });

  test('does not double-decrement activeCount when onStatus throws on task_completed', async () => {
    // Regression: when onStatus threw inside processResult (after the task
    // finished), the old .catch() guard would decrement activeCount a second
    // time, driving it negative and causing early termination / incorrect stats.
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: [] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: [] },
        { id: 'c', role: 'coder', objective: 'C', dependencies: ['a'] },
      ],
    });

    let throwCount = 0;
    const summary = await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...DEFAULT_LIMITS, maxWorkers: 2 }),
      backend: makeBackend(),
      workingDir: '/tmp',
      onStatus: (event) => {
        // Throw only on the first task_completed to simulate the bug scenario
        if (event.kind === 'task_completed' && throwCount === 0) {
          throwCount++;
          throw new Error('callback boom');
        }
      },
    });

    // Despite the throw, the remaining tasks should still run correctly.
    // With the old double-decrement bug, activeCount would go negative and
    // the orchestrator could terminate early or produce wrong stats.
    expect(summary.stats.totalTasks).toBe(3);
    // At least 2 tasks should complete (b always succeeds, plus either a or c)
    expect(summary.stats.completed).toBeGreaterThanOrEqual(2);
  });
});
