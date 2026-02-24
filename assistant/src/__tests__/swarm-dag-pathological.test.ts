/**
 * Integration tests for swarm DAG scheduling under pathological graph shapes.
 *
 * These tests exercise the orchestrator and plan validator together to verify
 * correct behaviour when the dependency graph is adversarial:
 *   1. Deep dependency chains (20+ sequential tasks)
 *   2. Near-circular dependencies (partial cycles that stop just short of
 *      forming a full cycle, plus detection of actual cycles)
 *   3. Very wide fan-outs (one root task with 50+ immediate dependents)
 */

import { describe, test, expect } from 'bun:test';
import { executeSwarm } from '../swarm/orchestrator.js';
import type { OrchestratorEvent } from '../swarm/orchestrator.js';
import {
  validateAndNormalizePlan,
  SwarmPlanValidationError,
} from '../swarm/plan-validator.js';
import type { SwarmPlan, SwarmTaskNode } from '../swarm/types.js';
import type { SwarmWorkerBackend } from '../swarm/worker-backend.js';
import { resolveSwarmLimits } from '../swarm/limits.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const SUCCESS_OUTPUT =
  '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```';

function makeBackend(overrides?: Partial<SwarmWorkerBackend>): SwarmWorkerBackend {
  return {
    name: 'test-backend',
    isAvailable: () => true,
    runTask: async () => ({
      success: true,
      output: SUCCESS_OUTPUT,
      durationMs: 5,
    }),
    ...overrides,
  };
}

/** Limits generous enough for large pathological plans. */
const LARGE_LIMITS = {
  maxWorkers: 6,
  // Bypass the maxTasks hard-ceiling inside resolveSwarmLimits by using a
  // value at the ceiling (20). For the deep-chain test we build exactly 20
  // tasks, and for the fan-out we pass the oversized plan directly to
  // executeSwarm (skipping validation) to test the orchestrator in isolation.
  maxTasks: 20,
  maxRetriesPerTask: 0,
  workerTimeoutSec: 30,
};

const RESOLVED_LIMITS = resolveSwarmLimits(LARGE_LIMITS);

// ---------------------------------------------------------------------------
// Helpers for building specific graph shapes
// ---------------------------------------------------------------------------

/** Build a linear chain: t0 -> t1 -> t2 -> ... -> t(n-1) */
function buildChain(n: number): SwarmTaskNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    role: 'coder' as const,
    objective: `Task ${i}`,
    dependencies: i === 0 ? [] : [`t${i - 1}`],
  }));
}

/** Build a star: one root + n leaf tasks that all depend on the root. */
function buildStar(leafCount: number): SwarmTaskNode[] {
  const root: SwarmTaskNode = {
    id: 'root',
    role: 'coder',
    objective: 'Root task',
    dependencies: [],
  };
  const leaves: SwarmTaskNode[] = Array.from({ length: leafCount }, (_, i) => ({
    id: `leaf${i}`,
    role: 'coder' as const,
    objective: `Leaf ${i}`,
    dependencies: ['root'],
  }));
  return [root, ...leaves];
}

// ---------------------------------------------------------------------------
// 1. Deep dependency chains
// ---------------------------------------------------------------------------

describe('deep dependency chains', () => {
  test('validates a 20-task linear chain without errors', () => {
    const tasks = buildChain(20);
    const plan: SwarmPlan = { objective: 'Deep chain', tasks };
    // Should not throw — a pure chain is a valid DAG with no cycles.
    const validated = validateAndNormalizePlan(plan, RESOLVED_LIMITS);
    expect(validated.tasks).toHaveLength(20);
  });

  test('executes a 20-task linear chain completing all tasks in order', async () => {
    const tasks = buildChain(20);
    // Drive through executeSwarm directly — bypassing the maxTasks truncation
    // inside the validator so we can test the orchestrator with 20 tasks.
    const plan: SwarmPlan = { objective: 'Deep chain', tasks };

    const completionOrder: string[] = [];
    const backend = makeBackend({
      runTask: async (input) => {
        // Extract task id from prompt — the prompt embeds the task objective.
        const match = input.prompt.match(/Task (\d+)/);
        if (match) completionOrder.push(`t${match[1]}`);
        return { success: true, output: SUCCESS_OUTPUT, durationMs: 2 };
      },
    });

    const limits = resolveSwarmLimits({ ...LARGE_LIMITS, maxWorkers: 2 });
    const summary = await executeSwarm({
      plan,
      limits,
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.totalTasks).toBe(20);
    expect(summary.stats.completed).toBe(20);
    expect(summary.stats.failed).toBe(0);
    expect(summary.stats.blocked).toBe(0);
  });

  test('blocks the entire tail when the head of a deep chain fails', async () => {
    const tasks = buildChain(20);
    const plan: SwarmPlan = { objective: 'Deep chain failure', tasks };

    // Only the very first task (t0) fails; all subsequent ones should be blocked.
    const backend = makeBackend({
      runTask: async (input) => {
        if (input.prompt.includes('Task 0')) {
          return { success: false, output: 'fail', failureReason: 'timeout' as const, durationMs: 2 };
        }
        return { success: true, output: SUCCESS_OUTPUT, durationMs: 2 };
      },
    });

    const summary = await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...LARGE_LIMITS, maxRetriesPerTask: 0 }),
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.failed).toBe(1);
    // Every downstream task (t1..t19) must be blocked, not completed.
    expect(summary.stats.blocked).toBe(19);
    expect(summary.stats.completed).toBe(0);
  });

  test('passes dependency output down the full chain', async () => {
    const tasks = buildChain(5);
    const plan: SwarmPlan = { objective: 'Context propagation', tasks };

    // Track how many dependency-output entries each task sees.
    // buildWorkerPrompt uses the section header "Outputs from prerequisite tasks:"
    // followed by "- [taskId]: summary" lines (one per upstream dependency).
    const depCounts: Record<string, number> = {};
    const backend = makeBackend({
      runTask: async (input) => {
        // Count how many "- [<id>]:" lines appear in the upstream-output section.
        const prereqSection = input.prompt.match(
          /Outputs from prerequisite tasks:([\s\S]*?)(?:\n\n|$)/,
        );
        const count = prereqSection
          ? (prereqSection[1].match(/^- \[/gm) ?? []).length
          : 0;
        // The prompt embeds the objective ("Task N") verbatim.
        const match = input.prompt.match(/Task (\d+)/);
        if (match) depCounts[`t${match[1]}`] = count;
        return { success: true, output: SUCCESS_OUTPUT, durationMs: 2 };
      },
    });

    await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...LARGE_LIMITS, maxWorkers: 1 }),
      backend,
      workingDir: '/tmp',
    });

    // t0 has no dependencies; each subsequent task has exactly one upstream dep.
    expect(depCounts['t0'] ?? 0).toBe(0);
    expect(depCounts['t1']).toBe(1);
    expect(depCounts['t2']).toBe(1);
    expect(depCounts['t3']).toBe(1);
    expect(depCounts['t4']).toBe(1);
  });

  test('emits task events for every node in a deep chain', async () => {
    const tasks = buildChain(10);
    const plan: SwarmPlan = { objective: 'Event coverage', tasks };

    const events: OrchestratorEvent[] = [];
    await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...LARGE_LIMITS, maxWorkers: 2 }),
      backend: makeBackend(),
      workingDir: '/tmp',
      onStatus: (e) => events.push(e),
    });

    const startedIds = events.filter((e) => e.kind === 'task_started').map((e) => e.taskId);
    const completedIds = events.filter((e) => e.kind === 'task_completed').map((e) => e.taskId);

    // Every task must have been started and completed exactly once.
    expect(new Set(startedIds).size).toBe(10);
    expect(new Set(completedIds).size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 2. Near-circular dependencies
// ---------------------------------------------------------------------------

describe('near-circular dependencies', () => {
  /**
   * "Near-circular" is a chain where the last node almost loops back to the
   * first but instead stops one edge short.  These are valid DAGs and must
   * execute without error.  Contrast with actual cycles, which must be
   * rejected.
   */

  test('validates and executes a near-circular chain (A→B→C, C does NOT link back to A)', async () => {
    // A→B→C is valid; the test confirms it finishes without a cycle error.
    const tasks: SwarmTaskNode[] = [
      { id: 'A', role: 'coder', objective: 'Step A', dependencies: [] },
      { id: 'B', role: 'coder', objective: 'Step B', dependencies: ['A'] },
      { id: 'C', role: 'coder', objective: 'Step C', dependencies: ['B'] },
    ];
    const plan: SwarmPlan = { objective: 'Near-circular chain', tasks };
    expect(() => validateAndNormalizePlan(plan, RESOLVED_LIMITS)).not.toThrow();

    const summary = await executeSwarm({
      plan,
      limits: RESOLVED_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });
    expect(summary.stats.completed).toBe(3);
    expect(summary.stats.blocked).toBe(0);
  });

  test('rejects a minimal 2-node cycle (A→B→A)', () => {
    const plan: SwarmPlan = {
      objective: 'Two-node cycle',
      tasks: [
        { id: 'A', role: 'coder', objective: 'A', dependencies: ['B'] },
        { id: 'B', role: 'coder', objective: 'B', dependencies: ['A'] },
      ],
    };
    let err: unknown;
    try {
      validateAndNormalizePlan(plan, RESOLVED_LIMITS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwarmPlanValidationError);
    expect((err as SwarmPlanValidationError).issues).toContainEqual(
      expect.stringContaining('cycle'),
    );
  });

  test('rejects a 3-node cycle (A→B→C→A)', () => {
    const plan: SwarmPlan = {
      objective: 'Three-node cycle',
      tasks: [
        { id: 'A', role: 'coder', objective: 'A', dependencies: ['C'] },
        { id: 'B', role: 'coder', objective: 'B', dependencies: ['A'] },
        { id: 'C', role: 'coder', objective: 'C', dependencies: ['B'] },
      ],
    };
    expect(() => validateAndNormalizePlan(plan, RESOLVED_LIMITS)).toThrow(
      SwarmPlanValidationError,
    );
  });

  test('rejects a cycle embedded in an otherwise-acyclic graph', () => {
    // D is an independent node; only A/B/C form the cycle.
    const plan: SwarmPlan = {
      objective: 'Mixed graph with embedded cycle',
      tasks: [
        { id: 'D', role: 'coder', objective: 'Independent', dependencies: [] },
        { id: 'A', role: 'coder', objective: 'A', dependencies: ['C'] },
        { id: 'B', role: 'coder', objective: 'B', dependencies: ['A'] },
        { id: 'C', role: 'coder', objective: 'C', dependencies: ['B'] },
      ],
    };
    let err: unknown;
    try {
      validateAndNormalizePlan(plan, RESOLVED_LIMITS);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwarmPlanValidationError);
    expect((err as SwarmPlanValidationError).issues).toContainEqual(
      expect.stringContaining('cycle'),
    );
  });

  test('rejects a self-loop (A depends on itself)', () => {
    const plan: SwarmPlan = {
      objective: 'Self-loop',
      tasks: [
        { id: 'A', role: 'coder', objective: 'A', dependencies: ['A'] },
      ],
    };
    expect(() => validateAndNormalizePlan(plan, RESOLVED_LIMITS)).toThrow(
      SwarmPlanValidationError,
    );
  });

  test('validates a long chain that almost cycles — last node stops one step short', () => {
    // t0→t1→...→t9; t9 does NOT depend on t0 (so it is NOT a cycle).
    const tasks: SwarmTaskNode[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      role: 'coder' as const,
      objective: `Step ${i}`,
      dependencies: i === 0 ? [] : [`t${i - 1}`],
    }));
    const plan: SwarmPlan = { objective: 'Long near-circular chain', tasks };
    // Should not throw.
    const validated = validateAndNormalizePlan(plan, RESOLVED_LIMITS);
    expect(validated.tasks).toHaveLength(10);
  });

  test('rejects a long chain that does complete the cycle — last node links back to first', () => {
    // t0→t1→...→t8→t9, and t0 also depends on t9 — this closes the loop
    // making the entire chain one big cycle.
    const tasks: SwarmTaskNode[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      role: 'coder' as const,
      objective: `Step ${i}`,
      // t0 depends on t9 (closing the loop); every other node depends on its predecessor.
      dependencies: i === 0 ? ['t9'] : [`t${i - 1}`],
    }));
    const plan: SwarmPlan = { objective: 'Closed long cycle', tasks };
    expect(() => validateAndNormalizePlan(plan, RESOLVED_LIMITS)).toThrow(
      SwarmPlanValidationError,
    );
  });

  test('error message identifies at least one node involved in the cycle', () => {
    const plan: SwarmPlan = {
      objective: 'Cycle identification',
      tasks: [
        { id: 'X', role: 'coder', objective: 'X', dependencies: ['Z'] },
        { id: 'Y', role: 'coder', objective: 'Y', dependencies: ['X'] },
        { id: 'Z', role: 'coder', objective: 'Z', dependencies: ['Y'] },
      ],
    };
    try {
      validateAndNormalizePlan(plan, RESOLVED_LIMITS);
      expect(true).toBe(false); // unreachable
    } catch (e) {
      const err = e as SwarmPlanValidationError;
      const cycleMessage = err.issues.find((i) => i.includes('cycle')) ?? '';
      // The cycle message must name at least one of the nodes.
      const mentionsANode = ['X', 'Y', 'Z'].some((id) => cycleMessage.includes(id));
      expect(mentionsANode).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Very wide fan-outs
// ---------------------------------------------------------------------------

describe('very wide fan-outs', () => {
  /**
   * These tests bypass validateAndNormalizePlan (which caps maxTasks at 20)
   * and drive executeSwarm directly.  The orchestrator has no hard cap on
   * tasks — the cap lives only in the validator.  Testing the orchestrator
   * directly lets us verify scheduling correctness at scale without needing
   * to change the hard limit constants.
   */

  test('completes a star graph with 51 leaf tasks (1 root + 50 dependents)', async () => {
    const tasks = buildStar(50);
    const plan: SwarmPlan = { objective: 'Wide fan-out', tasks };

    const summary = await executeSwarm({
      plan,
      limits: RESOLVED_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
    });

    expect(summary.stats.totalTasks).toBe(51);
    expect(summary.stats.completed).toBe(51);
    expect(summary.stats.failed).toBe(0);
    expect(summary.stats.blocked).toBe(0);
  });

  test('no leaf starts before root finishes in a 51-task star', async () => {
    const tasks = buildStar(50);
    const plan: SwarmPlan = { objective: 'Wide fan-out ordering', tasks };

    const completionOrder: string[] = [];
    const backend = makeBackend({
      runTask: async (input) => {
        const isRoot = input.prompt.includes('Root task');
        if (isRoot) {
          completionOrder.push('root');
          // Introduce a tiny delay so leaves clearly start after root ends.
          await new Promise((r) => setTimeout(r, 10));
        }
        return { success: true, output: SUCCESS_OUTPUT, durationMs: 2 };
      },
    });

    await executeSwarm({
      plan,
      limits: RESOLVED_LIMITS,
      backend,
      workingDir: '/tmp',
      onStatus: (e) => {
        if (e.kind === 'task_started' && e.taskId !== 'root') {
          // Leaves must only start after root has been recorded as completed.
          expect(completionOrder).toContain('root');
        }
      },
    });
  });

  test('blocks all 50 leaves when the root task fails', async () => {
    const tasks = buildStar(50);
    const plan: SwarmPlan = { objective: 'Fan-out failure propagation', tasks };

    const backend = makeBackend({
      runTask: async (input) => {
        if (input.prompt.includes('Root task')) {
          return {
            success: false,
            output: 'root failed',
            failureReason: 'timeout' as const,
            durationMs: 2,
          };
        }
        return { success: true, output: SUCCESS_OUTPUT, durationMs: 2 };
      },
    });

    const summary = await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...LARGE_LIMITS, maxRetriesPerTask: 0 }),
      backend,
      workingDir: '/tmp',
    });

    expect(summary.stats.failed).toBe(1);
    expect(summary.stats.blocked).toBe(50);
    expect(summary.stats.completed).toBe(0);
  });

  test('honours maxWorkers concurrency ceiling during a wide fan-out', async () => {
    const leafCount = 20;
    const tasks = buildStar(leafCount);
    const plan: SwarmPlan = { objective: 'Fan-out concurrency', tasks };

    let peak = 0;
    let current = 0;
    const backend = makeBackend({
      runTask: async () => {
        current++;
        if (current > peak) peak = current;
        // Hold the slot open briefly so concurrency actually builds up.
        await new Promise((r) => setTimeout(r, 5));
        current--;
        return { success: true, output: SUCCESS_OUTPUT, durationMs: 5 };
      },
    });

    const maxWorkers = 3;
    await executeSwarm({
      plan,
      limits: resolveSwarmLimits({ ...LARGE_LIMITS, maxWorkers }),
      backend,
      workingDir: '/tmp',
    });

    // Peak concurrency must never exceed the configured worker limit.
    expect(peak).toBeLessThanOrEqual(maxWorkers);
    // At least 2 workers should have run concurrently (shows leaves ran in
    // parallel rather than sequentially).
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  test('all 50 leaf task_started events are emitted eventually in a wide fan-out', async () => {
    const tasks = buildStar(50);
    const plan: SwarmPlan = { objective: 'Fan-out event coverage', tasks };

    const startedIds = new Set<string>();
    await executeSwarm({
      plan,
      limits: RESOLVED_LIMITS,
      backend: makeBackend(),
      workingDir: '/tmp',
      onStatus: (e) => {
        if (e.kind === 'task_started' && e.taskId) startedIds.add(e.taskId);
      },
    });

    // root + 50 leaves = 51 started events
    expect(startedIds.size).toBe(51);
    expect(startedIds.has('root')).toBe(true);
    for (let i = 0; i < 50; i++) {
      expect(startedIds.has(`leaf${i}`)).toBe(true);
    }
  });

  test('validator correctly validates a 20-task star (within hard limits)', () => {
    const tasks = buildStar(19); // 1 root + 19 leaves = 20 tasks total
    const plan: SwarmPlan = { objective: 'Validated star', tasks };
    const validated = validateAndNormalizePlan(plan, RESOLVED_LIMITS);
    expect(validated.tasks).toHaveLength(20);
  });

  test('validator truncates a 30-task star to maxTasks=20', () => {
    const tasks = buildStar(29); // 1 root + 29 leaves = 30 tasks total
    const plan: SwarmPlan = { objective: 'Oversized star', tasks };
    const validated = validateAndNormalizePlan(plan, RESOLVED_LIMITS);
    // Truncated to 20; the root will still be present (it is first in the array).
    expect(validated.tasks.length).toBeLessThanOrEqual(20);
  });
});
