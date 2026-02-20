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
import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { createTask, createTaskRun } from '../tasks/task-store.js';
import { createWorkItem } from '../work-items/work-item-store.js';
import { executeTaskSave } from '../tools/tasks/task-save.js';
import { executeTaskRun } from '../tools/tasks/task-run.js';
import { executeTaskList } from '../tools/tasks/task-list.js';
import { executeTaskListShow } from '../tools/tasks/work-item-list.js';
import { executeTaskListAdd } from '../tools/tasks/work-item-enqueue.js';
import { executeTaskDelete } from '../tools/tasks/task-delete.js';
import type { ToolContext } from '../tools/types.js';

initializeDb();

afterAll(() => {
  resetDb();
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

    const result = await executeTaskSave(
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

    const result = await executeTaskSave(
      { conversation_id: convId, title: 'My Custom Title' },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('My Custom Title');
  });

  test('uses context conversation_id when missing', async () => {
    const convId = createTestConversation(stubContext.conversationId);
    addTestMessage(convId, 'user', 'Summarize the report');
    addTestMessage(convId, 'assistant', 'Done.');

    const result = await executeTaskSave({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Task saved successfully');
    expect(result.content).toContain('Summarize the report');
  });

  test('returns error for nonexistent conversation', async () => {
    const result = await executeTaskSave(
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

    const result = await executeTaskRun(
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

    const result = await executeTaskRun(
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

    const result = await executeTaskRun(
      { task_name: 'nonexistent' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task template matching "nonexistent" found');
    expect(result.content).toContain('Existing Task');
  });

  test('returns error when task not found by ID', async () => {
    const result = await executeTaskRun(
      { task_id: 'bad-id' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task template found with ID "bad-id"');
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

    const result = await executeTaskRun(
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

    const result = await executeTaskRun(
      { task_name: 'input required' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Missing required inputs: file_path');
  });

  test('returns error when neither task_name nor task_id provided', async () => {
    const result = await executeTaskRun({}, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('At least one of task_name or task_id must be provided');
  });

  test('returns error with helpful message when no tasks exist', async () => {
    const result = await executeTaskRun(
      { task_name: 'anything' },
      stubContext,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task templates found');
  });

  test('includes required tools in output', async () => {
    createTask({
      title: 'Tools Task',
      template: 'Do the thing',
      requiredTools: ['file_read', 'bash'],
    });

    const result = await executeTaskRun(
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

    const result = await executeTaskList({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Found 2 task template(s)');
    expect(result.content).toContain('Task Alpha');
    expect(result.content).toContain('Task Beta');
    expect(result.content).toContain('file_read');
    expect(result.content).toContain('file_write');
    expect(result.content).toContain('file_path');
    expect(result.content).toContain('Tip: To see your active Tasks (work items in the queue), use the task_list_show tool.');
  });

  test('returns empty message when no tasks exist', async () => {
    const result = await executeTaskList({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('No task templates found');
    expect(result.content).toContain('Tip: To see your active Tasks (work items in the queue), use the task_list_show tool.');
  });

  test('shows task status and creation date', async () => {
    createTask({
      title: 'Dated Task',
      template: 'Something',
    });

    const result = await executeTaskList({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Status: active');
    expect(result.content).toContain('Created:');
  });
});

// ── task_list_show ───────────────────────────────────────────────────

describe('task_list_show tool', () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run('DELETE FROM work_items');
    raw.run('DELETE FROM task_runs');
    raw.run('DELETE FROM tasks');
  });

  test('lists work items when they exist', async () => {
    const task = createTask({ title: 'My Task', template: 'Do it' });
    createWorkItem({ taskId: task.id, title: 'Work Item Alpha', priorityTier: 0 });
    createWorkItem({ taskId: task.id, title: 'Work Item Beta', notes: 'some notes', priorityTier: 1 });

    const result = await executeTaskListShow({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Opened Tasks window (2 items)');
  });

  test('returns empty message when no work items', async () => {
    const result = await executeTaskListShow({}, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('no tasks queued');
  });

  test('filters by status when status param is provided', async () => {
    const task = createTask({ title: 'Filter Task', template: 'Do it' });
    createWorkItem({ taskId: task.id, title: 'Queued Item', priorityTier: 1 });
    const raw = getRawDb();
    // Create a second work item and manually set its status to 'done'
    const doneItem = createWorkItem({ taskId: task.id, title: 'Done Item', priorityTier: 1 });
    raw.query('UPDATE work_items SET status = ? WHERE id = ?').run('done', doneItem.id);

    const resultQueued = await executeTaskListShow({ status: 'queued' }, stubContext);
    expect(resultQueued.isError).toBe(false);
    expect(resultQueued.content).toContain('1 queued item');

    const resultDone = await executeTaskListShow({ status: 'done' }, stubContext);
    expect(resultDone.isError).toBe(false);
    expect(resultDone.content).toContain('1 done item');
  });
});

// ── task_list_add ────────────────────────────────────────────────────

describe('task_list_add tool', () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run('DELETE FROM work_items');
    raw.run('DELETE FROM task_runs');
    raw.run('DELETE FROM tasks');
  });

  test('successfully enqueues by task_id', async () => {
    const task = createTask({ title: 'Deploy Service', template: 'deploy it' });

    const result = await executeTaskListAdd({ task_id: task.id }, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enqueued work item');
    expect(result.content).toContain('Deploy Service');
    expect(result.content).toContain('Status: queued');
  });

  test('successfully enqueues by task_name (case-insensitive match)', async () => {
    createTask({ title: 'Run Database Migration', template: 'migrate' });

    const result = await executeTaskListAdd({ task_name: 'database migration' }, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enqueued work item');
    expect(result.content).toContain('Run Database Migration');
  });

  test('returns disambiguation when multiple name matches', async () => {
    createTask({ title: 'Deploy Frontend', template: 'deploy fe' });
    createTask({ title: 'Deploy Backend', template: 'deploy be' });

    const result = await executeTaskListAdd({ task_name: 'deploy' }, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Multiple task definitions match');
    expect(result.content).toContain('Deploy Frontend');
    expect(result.content).toContain('Deploy Backend');
  });

  test('returns error when no matching task found', async () => {
    createTask({ title: 'Existing Task', template: 'do something' });

    const result = await executeTaskListAdd({ task_name: 'nonexistent' }, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task definition found matching "nonexistent"');
  });

  test('returns error when no identifiers provided at all', async () => {
    const result = await executeTaskListAdd({}, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('You must provide either task_id, task_name, or title');
  });

  test('creates ad-hoc work item with just title (no task_id or task_name)', async () => {
    const result = await executeTaskListAdd(
      { title: 'Check Gmail' },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Enqueued work item');
    expect(result.content).toContain('Check Gmail');
    expect(result.content).toContain('Status: queued');
    // Ad-hoc items should not show "Task definition:" line
    expect(result.content).not.toContain('Task definition:');
  });

  test('ad-hoc work item with notes and priority', async () => {
    const result = await executeTaskListAdd(
      {
        title: 'Buy groceries',
        notes: 'Milk, eggs, bread',
        priority_tier: 1,
      },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Buy groceries');
    expect(result.content).toContain('Notes: Milk, eggs, bread');
    expect(result.content).toContain('Priority: medium');
  });

  test('ad-hoc work item shows up in task_list_show', async () => {
    await executeTaskListAdd(
      { title: 'Call dentist' },
      stubContext,
    );

    const listResult = await executeTaskListShow({}, stubContext);

    expect(listResult.isError).toBe(false);
    expect(listResult.content).toContain('Opened Tasks window (1 item)');
  });

  test('applies optional overrides (title, notes, priority_tier)', async () => {
    const task = createTask({ title: 'Generic Task', template: 'do it' });

    const result = await executeTaskListAdd(
      {
        task_id: task.id,
        title: 'Custom Title Override',
        notes: 'Important context here',
        priority_tier: 0,
      },
      stubContext,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Custom Title Override');
    expect(result.content).toContain('Notes: Important context here');
    expect(result.content).toContain('Priority: high');
  });
});

// ── task_delete ──────────────────────────────────────────────────────

describe('task_delete tool', () => {
  beforeEach(() => {
    const raw = getRawDb();
    raw.run('DELETE FROM work_items');
    raw.run('DELETE FROM task_runs');
    raw.run('DELETE FROM tasks');
  });

  test('successfully deletes a single task', async () => {
    const task = createTask({ title: 'Doomed Task', template: 'bye' });

    const result = await executeTaskDelete({ task_ids: [task.id] }, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Deleted task: Doomed Task');
  });

  test('successfully deletes multiple tasks', async () => {
    const t1 = createTask({ title: 'Task One', template: 'one' });
    const t2 = createTask({ title: 'Task Two', template: 'two' });

    const result = await executeTaskDelete({ task_ids: [t1.id, t2.id] }, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Deleted 2 task(s)');
    expect(result.content).toContain('Task One');
    expect(result.content).toContain('Task Two');
  });

  test('returns error for non-existent task ID', async () => {
    const result = await executeTaskDelete({ task_ids: ['nonexistent-id'] }, stubContext);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No task template or work item found with ID "nonexistent-id"');
  });

  test('cascades deletion to associated task runs and work items', async () => {
    const task = createTask({ title: 'Parent Task', template: 'parent' });
    createTaskRun(task.id);
    createWorkItem({ taskId: task.id, title: 'Child Work Item' });

    const raw = getRawDb();
    // Verify the associated records exist before deletion
    const runsBefore = raw.query('SELECT COUNT(*) as count FROM task_runs WHERE task_id = ?').get(task.id) as { count: number };
    const itemsBefore = raw.query('SELECT COUNT(*) as count FROM work_items WHERE task_id = ?').get(task.id) as { count: number };
    expect(runsBefore.count).toBe(1);
    expect(itemsBefore.count).toBe(1);

    const result = await executeTaskDelete({ task_ids: [task.id] }, stubContext);

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Deleted task: Parent Task');

    // Verify cascade: associated records should be gone
    const runsAfter = raw.query('SELECT COUNT(*) as count FROM task_runs WHERE task_id = ?').get(task.id) as { count: number };
    const itemsAfter = raw.query('SELECT COUNT(*) as count FROM work_items WHERE task_id = ?').get(task.id) as { count: number };
    expect(runsAfter.count).toBe(0);
    expect(itemsAfter.count).toBe(0);
  });
});
