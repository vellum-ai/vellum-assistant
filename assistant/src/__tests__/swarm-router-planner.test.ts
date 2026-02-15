import { describe, test, expect } from 'bun:test';
import { generatePlan, parsePlanJSON, makeFallbackPlan } from '../swarm/router-planner.js';
import { resolveSwarmLimits } from '../swarm/limits.js';
import type { Provider, ProviderResponse } from '../providers/types.js';

const DEFAULT_LIMITS = resolveSwarmLimits({
  maxWorkers: 3,
  maxTasks: 8,
  maxRetriesPerTask: 1,
  workerTimeoutSec: 900,
});

function makeProvider(responseText: string): Provider {
  return {
    name: 'test',
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [{ type: 'text', text: responseText }],
        model: 'test-model',
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      };
    },
  };
}

function makeFailingProvider(): Provider {
  return {
    name: 'test',
    async sendMessage(): Promise<ProviderResponse> {
      throw new Error('API error');
    },
  };
}

describe('parsePlanJSON', () => {
  test('parses bare JSON', () => {
    const result = parsePlanJSON('{"tasks":[{"id":"a","role":"coder","objective":"do stuff","dependencies":[]}]}');
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks[0].id).toBe('a');
  });

  test('parses fenced JSON', () => {
    const raw = '```json\n{"tasks":[{"id":"a","role":"coder","objective":"do stuff","dependencies":[]}]}\n```';
    const result = parsePlanJSON(raw);
    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(1);
  });

  test('parses fenced code block without json tag', () => {
    const raw = '```\n{"tasks":[{"id":"a","role":"coder","objective":"do stuff","dependencies":[]}]}\n```';
    const result = parsePlanJSON(raw);
    expect(result).not.toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parsePlanJSON('this is not json')).toBeNull();
  });

  test('returns null for JSON without tasks array', () => {
    expect(parsePlanJSON('{"plan":"something"}')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parsePlanJSON('')).toBeNull();
  });
});

describe('makeFallbackPlan', () => {
  test('creates single coder task', () => {
    const plan = makeFallbackPlan('Build a feature');
    expect(plan.objective).toBe('Build a feature');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].role).toBe('coder');
    expect(plan.tasks[0].id).toBe('fallback-coder');
    expect(plan.tasks[0].dependencies).toEqual([]);
  });
});

describe('generatePlan', () => {
  test('generates a valid plan from LLM response', async () => {
    const responseText = JSON.stringify({
      tasks: [
        { id: 'research', role: 'researcher', objective: 'Find docs', dependencies: [] },
        { id: 'code', role: 'coder', objective: 'Implement', dependencies: ['research'] },
      ],
    });
    const plan = await generatePlan({
      objective: 'Build feature X',
      provider: makeProvider(responseText),
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].id).toBe('research');
    expect(plan.tasks[1].dependencies).toContain('research');
  });

  test('falls back on invalid LLM JSON', async () => {
    const plan = await generatePlan({
      objective: 'Build feature X',
      provider: makeProvider('Sorry, I cannot help with that.'),
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('fallback-coder');
  });

  test('falls back when provider throws', async () => {
    const plan = await generatePlan({
      objective: 'Build feature X',
      provider: makeFailingProvider(),
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('fallback-coder');
  });

  test('falls back when LLM plan has invalid roles', async () => {
    const responseText = JSON.stringify({
      tasks: [
        { id: 'hack', role: 'hacker', objective: 'Hack stuff', dependencies: [] },
      ],
    });
    const plan = await generatePlan({
      objective: 'Build feature X',
      provider: makeProvider(responseText),
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    // Plan validator rejects invalid roles, so generatePlan catches and falls back
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('fallback-coder');
  });

  test('falls back when LLM plan has cycles', async () => {
    const responseText = JSON.stringify({
      tasks: [
        { id: 'a', role: 'coder', objective: 'A', dependencies: ['b'] },
        { id: 'b', role: 'coder', objective: 'B', dependencies: ['a'] },
      ],
    });
    const plan = await generatePlan({
      objective: 'Build feature X',
      provider: makeProvider(responseText),
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('fallback-coder');
  });

  test('truncates plans exceeding maxTasks', async () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `t${i}`,
      role: 'coder',
      objective: `Task ${i}`,
      dependencies: [],
    }));
    const plan = await generatePlan({
      objective: 'Big feature',
      provider: makeProvider(JSON.stringify({ tasks })),
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    expect(plan.tasks.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxTasks);
  });

  test('handles response with no text content', async () => {
    const provider: Provider = {
      name: 'test',
      async sendMessage(): Promise<ProviderResponse> {
        return {
          content: [],
          model: 'test-model',
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: 'end_turn',
        };
      },
    };
    const plan = await generatePlan({
      objective: 'Build feature',
      provider,
      model: 'test-model',
      limits: DEFAULT_LIMITS,
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].id).toBe('fallback-coder');
  });
});
