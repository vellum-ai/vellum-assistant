import { describe, expect, test } from 'bun:test';
import { subagentSpawnTool } from '../tools/subagent/spawn.js';
import { subagentStatusTool } from '../tools/subagent/status.js';
import { subagentAbortTool } from '../tools/subagent/abort.js';
import { subagentMessageTool } from '../tools/subagent/message.js';
import { subagentReadTool } from '../tools/subagent/read.js';

describe('Subagent tool shapes', () => {
  test('spawn tool has correct shape', () => {
    expect(subagentSpawnTool.name).toBe('subagent_spawn');
    expect(subagentSpawnTool.category).toBe('orchestration');
    expect(typeof subagentSpawnTool.execute).toBe('function');
    expect(typeof subagentSpawnTool.getDefinition).toBe('function');
    const def = subagentSpawnTool.getDefinition!();
    expect((def.input_schema as Record<string, unknown>).required).toEqual(['label', 'objective']);
  });

  test('status tool has correct shape', () => {
    expect(subagentStatusTool.name).toBe('subagent_status');
    expect(subagentStatusTool.category).toBe('orchestration');
    expect(typeof subagentStatusTool.execute).toBe('function');
  });

  test('abort tool has correct shape', () => {
    expect(subagentAbortTool.name).toBe('subagent_abort');
    expect(typeof subagentAbortTool.execute).toBe('function');
    const def = subagentAbortTool.getDefinition!();
    expect((def.input_schema as Record<string, unknown>).required).toEqual(['subagent_id']);
  });

  test('message tool has correct shape', () => {
    expect(subagentMessageTool.name).toBe('subagent_message');
    expect(typeof subagentMessageTool.execute).toBe('function');
    const def = subagentMessageTool.getDefinition!();
    expect((def.input_schema as Record<string, unknown>).required).toEqual(['subagent_id', 'content']);
  });

  test('read tool has correct shape', () => {
    expect(subagentReadTool.name).toBe('subagent_read');
    expect(typeof subagentReadTool.execute).toBe('function');
    const def = subagentReadTool.getDefinition!();
    expect((def.input_schema as Record<string, unknown>).required).toEqual(['subagent_id']);
  });
});

describe('Subagent tool execute validation', () => {
  test('spawn returns error when no sendToClient', async () => {
    const result = await subagentSpawnTool.execute(
      { label: 'test', objective: 'do something' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No IPC client');
  });

  test('spawn returns error when missing label', async () => {
    const result = await subagentSpawnTool.execute(
      { objective: 'do something' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1', sendToClient: () => {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('required');
  });

  test('status returns empty when no subagents', async () => {
    const result = await subagentStatusTool.execute(
      {},
      { workingDir: '/tmp', sessionId: 'nonexistent-session', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('No subagents found');
  });

  test('status returns error for unknown subagent_id', async () => {
    const result = await subagentStatusTool.execute(
      { subagent_id: 'nonexistent-id' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No subagent found');
  });

  test('abort returns error for unknown subagent_id', async () => {
    const result = await subagentAbortTool.execute(
      { subagent_id: 'nonexistent-id' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not abort');
  });

  test('abort returns error when missing subagent_id', async () => {
    const result = await subagentAbortTool.execute(
      {},
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('required');
  });

  test('message returns error for unknown subagent_id', async () => {
    const result = await subagentMessageTool.execute(
      { subagent_id: 'nonexistent-id', content: 'hello' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Could not send');
  });

  test('message returns error when missing required fields', async () => {
    const result = await subagentMessageTool.execute(
      { subagent_id: 'some-id' },
      { workingDir: '/tmp', sessionId: 'sess-1', conversationId: 'conv-1' },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('required');
  });
});
