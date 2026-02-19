import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeSubagentSpawn } from '../tools/subagent/spawn.js';
import { executeSubagentStatus } from '../tools/subagent/status.js';
import { executeSubagentAbort } from '../tools/subagent/abort.js';
import { executeSubagentMessage } from '../tools/subagent/message.js';

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
