import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock the Agent SDK — prevents real subprocess spawning
// ---------------------------------------------------------------------------
const queryMock = mock(() => {
  // Returns an async iterable that yields a success result
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result' as const,
        session_id: 'test-session',
        subtype: 'success' as const,
        result: 'Done.',
      };
    },
  };
});

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

// Mock logger
mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

// Mock config
mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    apiKeys: { anthropic: 'test-key' },
  }),
}));

import { claudeCodeTool } from '../tools/claude-code/claude-code.js';
import type { ToolContext } from '../tools/types.js';

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/test',
    onOutput: () => {},
    ...overrides,
  } as ToolContext;
}

describe('claude_code tool profile support', () => {
  beforeEach(() => {
    queryMock.mockClear();
  });

  test('getDefinition includes profile parameter', () => {
    const def = claudeCodeTool.getDefinition();
    const props = (def.input_schema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.profile).toBeDefined();
  });

  test('rejects invalid profile', async () => {
    const result = await claudeCodeTool.execute(
      { prompt: 'test', profile: 'hacker' },
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid profile');
  });

  test('accepts valid profiles without error', async () => {
    for (const profile of ['general', 'researcher', 'coder', 'reviewer']) {
      queryMock.mockClear();
      const result = await claudeCodeTool.execute(
        { prompt: 'test', profile },
        makeContext(),
      );
      expect(result.isError).toBeFalsy();
    }
  });

  test('omitted profile defaults to general (backward compat)', async () => {
    const result = await claudeCodeTool.execute(
      { prompt: 'test' },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
  });

  test('worker profile allows all tools', () => {
    const { getProfilePolicy } = require('../swarm/worker-backend.js') as typeof import('../swarm/worker-backend.js');
    const policy = getProfilePolicy('worker');

    // Worker should allow all tool categories
    expect(policy.allow.has('Bash')).toBe(true);
    expect(policy.allow.has('Write')).toBe(true);
    expect(policy.allow.has('Edit')).toBe(true);
    expect(policy.allow.has('Task')).toBe(true);
    expect(policy.allow.has('Read')).toBe(true);
    expect(policy.allow.has('Glob')).toBe(true);
    expect(policy.allow.has('Grep')).toBe(true);

    // Deny and approvalRequired should be empty
    expect(policy.deny.size).toBe(0);
    expect(policy.approvalRequired.size).toBe(0);
  });

  test('worker profile is valid in tool definition', () => {
    const def = claudeCodeTool.getDefinition();
    const props = (def.input_schema as Record<string, unknown>).properties as Record<string, { enum?: string[] }>;
    const profileEnum = props.profile.enum;
    expect(profileEnum).toBeDefined();
    expect(profileEnum).toContain('worker');
  });

  test('accepts worker profile without error', async () => {
    const result = await claudeCodeTool.execute(
      { prompt: 'test', profile: 'worker' },
      makeContext(),
    );
    expect(result.isError).toBeFalsy();
  });
});
