import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeSubagentSpawn } from '../tools/subagent/spawn.js';
import { executeSubagentStatus } from '../tools/subagent/status.js';
import { executeSubagentAbort } from '../tools/subagent/abort.js';
import { executeSubagentMessage } from '../tools/subagent/message.js';
import { executeSubagentRead } from '../tools/subagent/read.js';
import { SubagentManager } from '../subagent/manager.js';
import type { SubagentState } from '../subagent/types.js';

// Load tool definitions from the bundled skill TOOLS.json
const toolsJson = JSON.parse(
  readFileSync(join(import.meta.dirname, '../config/bundled-skills/subagent/TOOLS.json'), 'utf-8'),
);
const findTool = (name: string) => toolsJson.tools.find((t: { name: string }) => t.name === name);

describe('Subagent tool definitions', () => {
  test('spawn tool has correct definition', () => {
    const def = findTool('subagent_spawn');
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(['label', 'objective']);
  });

  test('abort tool has correct definition', () => {
    const def = findTool('subagent_abort');
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(['subagent_id']);
  });

  test('message tool has correct definition', () => {
    const def = findTool('subagent_message');
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(['subagent_id', 'content']);
  });

  test('read tool has correct definition', () => {
    const def = findTool('subagent_read');
    expect(def).toBeDefined();
    expect(def.input_schema.required).toEqual(['subagent_id']);
  });
});

describe('Subagent tool execute validation', () => {
  test('spawn returns error when no sendToClient', async () => {
    const result = await executeSubagentSpawn(
      { label: 'test', objective: 'do something' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No IPC client');
  });

  test('spawn returns error when missing label', async () => {
    const result = await executeSubagentSpawn(
      { objective: 'do something' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1', sendToClient: () => {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('required');
  });

  test('status returns empty when no subagents', async () => {
    const result = await executeSubagentStatus(
      {},
      { workingDir: '/tmp', sessionId: 'nonexistent-session', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No subagents found');
  });

  test('status returns error for unknown subagent_id', async () => {
    const result = await executeSubagentStatus(
      { subagent_id: 'nonexistent-id' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No subagent found');
  });

  test('abort returns error for unknown subagent_id', async () => {
    const result = await executeSubagentAbort(
      { subagent_id: 'nonexistent-id' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not abort');
  });

  test('abort returns error when missing subagent_id', async () => {
    const result = await executeSubagentAbort(
      {},
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('required');
  });

  test('message returns error for unknown subagent_id', async () => {
    const result = await executeSubagentMessage(
      { subagent_id: 'nonexistent-id', content: 'hello' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not send');
  });

  test('message returns error when missing required fields', async () => {
    const result = await executeSubagentMessage(
      { subagent_id: 'some-id' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('required');
  });
});

// ── Ownership validation tests ──────────────────────────────────────

/**
 * Inject a fake subagent into the singleton manager so tool executors
 * can find it. Uses the same private-internals trick as the notify tests.
 */
function injectSubagent(
  manager: SubagentManager,
  subagentId: string,
  parentSessionId: string,
  status: SubagentState['status'] = 'running',
): void {
  const internals = manager as unknown as {
    subagents: Map<string, { session: unknown; state: SubagentState; parentSendToClient: () => void }>;
    parentToChildren: Map<string, Set<string>>;
  };
  const state: SubagentState = {
    config: { id: subagentId, parentSessionId, label: 'Test', objective: 'test' },
    status,
    conversationId: `conv-${subagentId}`,
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
  const fakeSession = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  };
  internals.subagents.set(subagentId, { session: fakeSession, state, parentSendToClient: () => {} });
  if (!internals.parentToChildren.has(parentSessionId)) {
    internals.parentToChildren.set(parentSessionId, new Set());
  }
  internals.parentToChildren.get(parentSessionId)!.add(subagentId);
}

import { getSubagentManager } from '../subagent/index.js';

describe('Subagent tool ownership validation', () => {
  const ownerSession = 'owner-sess';
  const otherSession = 'other-sess';
  const subagentId = 'owned-sub-1';

  // Inject once — all tests share this subagent.
  const manager = getSubagentManager();
  injectSubagent(manager, subagentId, ownerSession);

  test('status rejects non-owner session', async () => {
    const result = await executeSubagentStatus(
      { subagent_id: subagentId },
      { workingDir: '/tmp', sessionId: otherSession, conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No subagent found');
  });

  test('status succeeds for owner session', async () => {
    const result = await executeSubagentStatus(
      { subagent_id: subagentId },
      { workingDir: '/tmp', sessionId: ownerSession, conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(false);
  });

  test('message rejects non-owner session', async () => {
    const result = await executeSubagentMessage(
      { subagent_id: subagentId, content: 'hello' },
      { workingDir: '/tmp', sessionId: otherSession, conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not send');
  });

  test('read rejects non-owner session', async () => {
    const result = await executeSubagentRead(
      { subagent_id: subagentId },
      { workingDir: '/tmp', sessionId: otherSession, conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No subagent found');
  });

  test('abort rejects non-owner session', async () => {
    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      { workingDir: '/tmp', sessionId: otherSession, conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not abort');
  });

  test('abort succeeds for owner session', async () => {
    const result = await executeSubagentAbort(
      { subagent_id: subagentId },
      { workingDir: '/tmp', sessionId: ownerSession, conversationId: 'conv-1' },
    );
    // Abort succeeds (subagent was running)
    expect(result.isError).toBe(false);
  });
});
