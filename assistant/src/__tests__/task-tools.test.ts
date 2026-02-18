import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'task-tools-test-'));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  migrateToDataLayout: () => {},
  migrateToWorkspaceLayout: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({ memory: {} }),
}));

mock.module('./indexer.js', () => ({
  indexMessageNow: () => {},
}));

import type { Database } from 'bun:sqlite';
import { initializeDb, getDb } from '../memory/db.js';
import { createTask } from '../tasks/task-store.js';
import { taskSaveTool } from '../tools/tasks/task-save.js';
import { taskRunTool } from '../tools/tasks/task-run.js';
import { taskListTool } from '../tools/tasks/task-list.js';
import type { ToolContext } from '../tools/types.js';

initializeDb();

afterAll(() => {
  try { rmSync(testDir, { recursive: true }); } catch { /* best effort */ }
});

// ── Helpers ──────────────────────────────────────────────────────────

function getRawDb(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function createTestConversation(id: string): string {
  const raw = getRawDb();
  const now = Date.now();
  raw.query(
    `INSERT INTO conversations (id, title, created_at, updated_at, thread_type, memory_scope_id) VALUES (?, 'Test', ?, ?, 'standard', 'default')`,
  ).run(id, now, now);
  return id;
}

function addTestMessage(conversationId: string, role: string, content: string): void {
  const raw = getRawDb();
  const id = crypto.randomUUID();
  const now = Date.now();
  raw.query(
    `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, conversationId, role, content, now);
}

const stubContext: ToolContext = {
  workingDir: '/tmp',
  sessionId: 'test-session',
  conversationId: 'test-conversation',
};

// ── task_save ────────────────────────────────────────────────────────

describe('task_save tool', () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run('DELETE FROM task_runs');
    raw.run('DELETE FROM tasks');
    raw.run('DELETE FROM messages');
    raw.run('DELETE FROM conversations');
  });

  test('creates a task from a conversation', async () => {
    const convId = createTestConversation('conv-save-1');
    addTestMessage(convId, 'user', 'Please summarize the document');
    addTestMessage(
      convId,
      'assistant',
      JSON.stringify([
        { type: 'tool_use', id: 'tu1', name: 'file_read', input: { path: '/tmp/doc.txt' } },
      ]),
    );
    addTestMessage(convId, 'assistant', 'Here is the summary...');

    const result = await taskSaveTool.execute(
      { conversation_id: convId },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Task saved successfully');
    expect(result.content).toContain('Please summarize the document');
    expect(result.content).toContain('file_read');
  });

  test('uses title override when provided', async () => {
    const convId = createTestConversation('conv-save-2');
    addTestMessage(convId, 'user', 'Read and analyze the logs');
    addTestMessage(convId, 'assistant', 'Done!');

    const result = await taskSaveTool.execute(
      { conversation_id: convId, title: 'My Custom Title' },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('My Custom Title');
  });

  test('returns error for missing conversation_id', async () => {
    const result = await taskSaveTool.execute({}, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('conversation_id is required');
  });

  test('returns error for nonexistent conversation', async () => {
    const result = await taskSaveTool.execute(
      { conversation_id: 'nonexistent' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No messages found');
  });
});

// ── task_run ─────────────────────────────────────────────────────────

describe('task_run tool', () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run('DELETE FROM task_runs');
    raw.run('DELETE FROM tasks');
    raw.run('DELETE FROM messages');
    raw.run('DELETE FROM conversations');
  });

  test('resolves task by name (fuzzy match)', async () => {
    createTask({
      title: 'Summarize Document',
      template: 'Please summarize {{file_path}}',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: 'The file path' } } },
      requiredTools: ['file_read'],
    });

    const result = await taskRunTool.execute(
      { task_name: 'summarize', inputs: { file_path: '/tmp/report.txt' } },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Summarize Document');
    expect(result.content).toContain('Please summarize /tmp/report.txt');
  });

  test('resolves task by ID', async () => {
    const task = createTask({
      title: 'Deploy App',
      template: 'Deploy the application to {{url}}',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL' } } },
    });

    const result = await taskRunTool.execute(
      { task_id: task.id, inputs: { url: 'https://prod.example.com' } },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Deploy App');
    expect(result.content).toContain('Deploy the application to https://prod.example.com');
  });

  test('returns error when task not found by name', async () => {
    createTask({
      title: 'Existing Task',
      template: 'Do something',
    });

    const result = await taskRunTool.execute(
      { task_name: 'nonexistent' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task matching "nonexistent" found');
    expect(result.content).toContain('Existing Task');
  });

  test('returns error when task not found by ID', async () => {
    const result = await taskRunTool.execute(
      { task_id: 'bad-id' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task found with ID "bad-id"');
  });

  test('renders template with inputs', async () => {
    createTask({
      title: 'Multi-input Task',
      template: 'Read {{file_path}} and post to {{url}}',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File' },
          url: { type: 'string', description: 'URL' },
        },
      },
    });

    const result = await taskRunTool.execute(
      {
        task_name: 'multi-input',
        inputs: { file_path: '/home/user/data.csv', url: 'https://api.example.com/upload' },
      },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Read /home/user/data.csv and post to https://api.example.com/upload');
  });

  test('returns error when required inputs are missing', async () => {
    createTask({
      title: 'Input Required Task',
      template: 'Process {{file_path}}',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'File' } },
      },
    });

    const result = await taskRunTool.execute(
      { task_name: 'input required' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Missing required inputs: file_path');
  });

  test('returns error when neither task_name nor task_id provided', async () => {
    const result = await taskRunTool.execute({}, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('At least one of task_name or task_id must be provided');
  });

  test('returns error with helpful message when no tasks exist', async () => {
    const result = await taskRunTool.execute(
      { task_name: 'anything' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No saved tasks found');
  });

  test('includes required tools in output', async () => {
    createTask({
      title: 'Tools Task',
      template: 'Do the thing',
      requiredTools: ['file_read', 'bash'],
    });

    const result = await taskRunTool.execute(
      { task_name: 'tools' },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Required tools: file_read, bash');
  });
});

// ── task_list ────────────────────────────────────────────────────────

describe('task_list tool', () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run('DELETE FROM task_runs');
    raw.run('DELETE FROM tasks');
    raw.run('DELETE FROM messages');
    raw.run('DELETE FROM conversations');
  });

  test('returns formatted list of tasks', async () => {
    createTask({
      title: 'Task Alpha',
      template: 'Do alpha things',
      requiredTools: ['file_read'],
    });
    createTask({
      title: 'Task Beta',
      template: 'Do beta {{file_path}}',
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'File' } },
      },
      requiredTools: ['file_read', 'file_write'],
    });

    const result = await taskListTool.execute({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Found 2 saved task(s)');
    expect(result.content).toContain('Task Alpha');
    expect(result.content).toContain('Task Beta');
    expect(result.content).toContain('file_read');
    expect(result.content).toContain('file_write');
    expect(result.content).toContain('file_path');
  });

  test('returns empty message when no tasks exist', async () => {
    const result = await taskListTool.execute({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No saved tasks found');
  });

  test('shows task status and creation date', async () => {
    createTask({
      title: 'Dated Task',
      template: 'Something',
    });

    const result = await taskListTool.execute({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Status: active');
    expect(result.content).toContain('Created:');
  });
});
