import { describe, test, expect, beforeAll, mock } from 'bun:test';

// Mock config before importing modules that depend on it.
mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    provider: 'mock-provider',
    permissions: { mode: 'legacy' },
    apiKeys: {},
    sandbox: { enabled: false },
    timeouts: { toolExecutionTimeoutSec: 30, permissionTimeoutSec: 5 },
    skills: { load: { extraDirs: [] } },
    secretDetection: { enabled: false },
    contextWindow: {
      enabled: true,
      maxInputTokens: 180000,
      targetInputTokens: 110000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryMaxTokens: 1200,
      chunkTokens: 12000,
    },
  }),
  invalidateConfigCache: () => {},
}));

import { ComputerUseSession } from '../daemon/computer-use-session.js';
import type { Provider, ProviderResponse } from '../providers/types.js';
import type { CuObservation } from '../daemon/ipc-protocol.js';
import {
  initializeTools,
  getAllTools,
  getSkillRefCount,
  __resetRegistryForTesting,
} from '../tools/registry.js';


function createProvider(responses: ProviderResponse[]): Provider {
  let calls = 0;
  return {
    name: 'mock',
    async sendMessage() {
      const response = responses[calls] ?? responses[responses.length - 1];
      calls++;
      return response;
    },
  };
}

const doneResponse: ProviderResponse = {
  content: [{
    type: 'tool_use',
    id: 'tu-cleanup',
    name: 'computer_use_done',
    input: { summary: 'Done' },
  }],
  model: 'mock-model',
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: 'tool_use',
};

const observation: CuObservation = {
  type: 'cu_observation',
  sessionId: 'cleanup-test',
  axTree: 'Window "Test" [1]',
};

describe('CU session skill tool lifecycle cleanup', () => {
  beforeAll(async () => {
    __resetRegistryForTesting();
    await initializeTools();
  });

  test('computer-use skill refcount is 0 after session completes via computer_use_done', async () => {
    const provider = createProvider([doneResponse]);
    const session = new ComputerUseSession(
      'cleanup-done',
      'test cleanup',
      1440, 900,
      provider,
      () => {},
      'computer_use',
    );

    expect(getSkillRefCount('computer-use')).toBe(0);

    await session.handleObservation({ ...observation, sessionId: 'cleanup-done' });

    expect(session.getState()).toBe('complete');
    expect(getSkillRefCount('computer-use')).toBe(0);
  });

  test('computer-use skill refcount is 0 after session is aborted', () => {
    const provider = createProvider([doneResponse]);
    const session = new ComputerUseSession(
      'cleanup-abort',
      'test abort cleanup',
      1440, 900,
      provider,
      () => {},
      'computer_use',
    );

    // Projection hasn't happened yet so refcount should be 0
    expect(getSkillRefCount('computer-use')).toBe(0);

    session.abort();

    expect(session.getState()).toBe('error');
    expect(getSkillRefCount('computer-use')).toBe(0);
  });

  test('computer-use skill refcount is 0 after session completes via computer_use_respond', async () => {
    const provider = createProvider([{
      content: [{
        type: 'tool_use',
        id: 'tu-respond-cleanup',
        name: 'computer_use_respond',
        input: { answer: 'Test answer', reasoning: 'Test reasoning' },
      }],
      model: 'mock-model',
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: 'tool_use',
    }]);

    const session = new ComputerUseSession(
      'cleanup-respond',
      'test respond cleanup',
      1440, 900,
      provider,
      () => {},
      'computer_use',
    );

    await session.handleObservation({ ...observation, sessionId: 'cleanup-respond' });

    expect(session.getState()).toBe('complete');
    expect(getSkillRefCount('computer-use')).toBe(0);
  });

  test('no computer_use_* tools remain in registry after session cleanup', async () => {
    const provider = createProvider([doneResponse]);
    const session = new ComputerUseSession(
      'cleanup-registry-check',
      'test registry cleanup',
      1440, 900,
      provider,
      () => {},
      'computer_use',
    );

    await session.handleObservation({ ...observation, sessionId: 'cleanup-registry-check' });

    expect(session.getState()).toBe('complete');

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    expect(cuTools).toHaveLength(0);
  });

  test('multiple sequential CU sessions do not leak refcounts', async () => {
    for (let i = 0; i < 3; i++) {
      const provider = createProvider([doneResponse]);
      const session = new ComputerUseSession(
        `cleanup-sequential-${i}`,
        'test sequential cleanup',
        1440, 900,
        provider,
        () => {},
        'computer_use',
      );

      await session.handleObservation({ ...observation, sessionId: `cleanup-sequential-${i}` });
      expect(session.getState()).toBe('complete');
    }

    expect(getSkillRefCount('computer-use')).toBe(0);

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    expect(cuTools).toHaveLength(0);
  });

  // Cross-suite regression: after CU sessions complete, core registry invariants hold
  test('core registry has 0 computer_use_* tools after CU session lifecycle', () => {
    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith('computer_use_'));
    expect(cuTools).toHaveLength(0);
  });

  test('request_computer_control remains in registry after CU session lifecycle', () => {
    const { getTool } = require('../tools/registry.js');
    const tool = getTool('request_computer_control');
    expect(tool).toBeDefined();
    expect(tool.name).toBe('request_computer_control');
  });
});
