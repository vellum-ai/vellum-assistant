import { describe, test, expect } from 'bun:test';
import {
  validateAndNormalizePlan,
  SwarmPlanValidationError,
  resolveSwarmLimits,
} from '../swarm/index.js';
import type { SwarmPlan } from '../swarm/index.js';

const DEFAULT_LIMITS = resolveSwarmLimits({
  maxWorkers: 3,
  maxTasks: 8,
  maxRetriesPerTask: 1,
  workerTimeoutSec: 900,
});

function makePlan(overrides?: Partial<SwarmPlan>): SwarmPlan {
  return {
    objective: 'Test objective',
    tasks: [
      { id: 'task-1', role: 'coder', objective: 'Write code', dependencies: [] },
    ],
    ...overrides,
  };
}

describe('validateAndNormalizePlan', () => {
  test('accepts a valid single-task plan', () => {
    const plan = makePlan();
    const result = validateAndNormalizePlan(plan, DEFAULT_LIMITS);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('task-1');
  });

  test('accepts a valid multi-task DAG', () => {
    const plan = makePlan({
      tasks: [
        { id: 'research', role: 'researcher', objective: 'Research', dependencies: [] },
        { id: 'code', role: 'coder', objective: 'Code', dependencies: ['research'] },
        { id: 'review', role: 'reviewer', objective: 'Review', dependencies: ['code'] },
      ],
    });
    const result = validateAndNormalizePlan(plan, DEFAULT_LIMITS);
    expect(result.tasks).toHaveLength(3);
  });

  test('accepts parallel independent tasks', () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'Task A', dependencies: [] },
        { id: 'b', role: 'coder', objective: 'Task B', dependencies: [] },
        { id: 'c', role: 'reviewer', objective: 'Review both', dependencies: ['a', 'b'] },
      ],
    });
    const result = validateAndNormalizePlan(plan, DEFAULT_LIMITS);
    expect(result.tasks).toHaveLength(3);
  });

  test('rejects empty tasks array', () => {
    expect(() =>
      validateAndNormalizePlan(makePlan({ tasks: [] }), DEFAULT_LIMITS),
    ).toThrow(SwarmPlanValidationError);
  });

  test('rejects duplicate task IDs', () => {
    const plan = makePlan({
      tasks: [
        { id: 'dup', role: 'coder', objective: 'A', dependencies: [] },
        { id: 'dup', role: 'coder', objective: 'B', dependencies: [] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false); // should not reach here
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('Duplicate task id'),
      );
    }
  });

  test('rejects invalid role', () => {
    const plan = makePlan({
      tasks: [
        { id: 'bad', role: 'hacker' as any, objective: 'Hack', dependencies: [] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('invalid role'),
      );
    }
  });

  test('rejects unknown dependency reference', () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: ['nonexistent'] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('unknown task "nonexistent"'),
      );
    }
  });

  test('detects simple cycle (A -> B -> A)', () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: ['b'] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: ['a'] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('cycle'),
      );
    }
  });

  test('detects self-cycle', () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: ['a'] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('cycle'),
      );
    }
  });

  test('detects longer cycle (A -> B -> C -> A)', () => {
    const plan = makePlan({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: ['c'] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: ['a'] },
        { id: 'c', role: 'coder', objective: 'C', dependencies: ['b'] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('cycle'),
      );
    }
  });

  test('truncates tasks exceeding maxTasks limit', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `t${i}`,
      role: 'coder' as const,
      objective: `Task ${i}`,
      dependencies: [] as string[],
    }));
    const plan = makePlan({ tasks });
    // Use a limit of 5
    const limits = resolveSwarmLimits({
      maxWorkers: 3,
      maxTasks: 5,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
    });
    const result = validateAndNormalizePlan(plan, limits);
    expect(result.tasks).toHaveLength(5);
    expect(result.tasks[0].id).toBe('t0');
    expect(result.tasks[4].id).toBe('t4');
  });

  test('strips dependencies that point to tasks removed by truncation', () => {
    const plan = makePlan({
      tasks: [
        { id: 't0', role: 'coder', objective: 'Task 0', dependencies: [] },
        { id: 't1', role: 'coder', objective: 'Task 1', dependencies: ['t4'] },
        { id: 't2', role: 'reviewer', objective: 'Task 2', dependencies: ['t0'] },
        { id: 't3', role: 'coder', objective: 'Task 3', dependencies: [] },
        { id: 't4', role: 'coder', objective: 'Task 4', dependencies: [] },
      ],
    });
    const limits = resolveSwarmLimits({
      maxWorkers: 3,
      maxTasks: 3,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
    });

    const result = validateAndNormalizePlan(plan, limits);
    expect(result.tasks).toHaveLength(3);
    const t1 = result.tasks.find((task) => task.id === 't1');
    expect(t1?.dependencies).toEqual([]);
  });

  test('rejects empty objective', () => {
    const plan = makePlan({ objective: '' });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      expect((e as SwarmPlanValidationError).issues).toContainEqual(
        expect.stringContaining('objective'),
      );
    }
  });

  test('normalizes missing dependencies to empty array', () => {
    const plan: SwarmPlan = {
      objective: 'Test',
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: undefined as any },
      ],
    };
    const result = validateAndNormalizePlan(plan, DEFAULT_LIMITS);
    expect(result.tasks[0].dependencies).toEqual([]);
  });

  test('collects multiple issues in a single error', () => {
    const plan = makePlan({
      objective: '',
      tasks: [
        { id: 'a', role: 'invalid' as any, objective: 'A', dependencies: ['nonexistent'] },
        { id: 'a', role: 'coder', objective: 'B', dependencies: [] },
      ],
    });
    try {
      validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SwarmPlanValidationError);
      const err = e as SwarmPlanValidationError;
      // Should have at least 3 issues: empty objective, invalid role, duplicate id
      expect(err.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('accepts all valid roles', () => {
    const roles = ['router', 'researcher', 'coder', 'reviewer'] as const;
    for (const role of roles) {
      const plan = makePlan({
        tasks: [{ id: `task-${role}`, role, objective: `${role} task`, dependencies: [] }],
      });
      const result = validateAndNormalizePlan(plan, DEFAULT_LIMITS);
      expect(result.tasks[0].role).toBe(role);
    }
  });
});

describe('resolveSwarmLimits', () => {
  test('clamps maxWorkers to hard ceiling', () => {
    const limits = resolveSwarmLimits({
      maxWorkers: 100,
      maxTasks: 8,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
    });
    expect(limits.maxWorkers).toBe(6);
  });

  test('clamps maxTasks to hard ceiling', () => {
    const limits = resolveSwarmLimits({
      maxWorkers: 3,
      maxTasks: 100,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
    });
    expect(limits.maxTasks).toBe(20);
  });

  test('clamps maxRetriesPerTask to hard ceiling', () => {
    const limits = resolveSwarmLimits({
      maxWorkers: 3,
      maxTasks: 8,
      maxRetriesPerTask: 100,
      workerTimeoutSec: 900,
    });
    expect(limits.maxRetriesPerTask).toBe(3);
  });

  test('clamps zero/negative values to minimums', () => {
    const limits = resolveSwarmLimits({
      maxWorkers: 0,
      maxTasks: -1,
      maxRetriesPerTask: -5,
      workerTimeoutSec: 0,
    });
    expect(limits.maxWorkers).toBe(1);
    expect(limits.maxTasks).toBe(1);
    expect(limits.maxRetriesPerTask).toBe(0);
    expect(limits.workerTimeoutSec).toBe(1);
  });

  test('passes through valid values unchanged', () => {
    const limits = resolveSwarmLimits({
      maxWorkers: 3,
      maxTasks: 8,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
    });
    expect(limits).toEqual({
      maxWorkers: 3,
      maxTasks: 8,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
    });
  });
});
