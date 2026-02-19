import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mock platform to isolate tests from the real workspace ────────────
const TEST_DIR = join(tmpdir(), `vellum-routing-test-${crypto.randomUUID()}`);

mock.module('../util/platform.js', () => ({
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  getWorkspaceDir: () => TEST_DIR,
  getWorkspaceConfigPath: () => join(TEST_DIR, 'config.json'),
  getWorkspaceSkillsDir: () => join(TEST_DIR, 'skills'),
  getWorkspaceHooksDir: () => join(TEST_DIR, 'hooks'),
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, 'vellum.sock'),
  getPidPath: () => join(TEST_DIR, 'vellum.pid'),
  getDbPath: () => join(TEST_DIR, 'data', 'assistant.db'),
  getLogPath: () => join(TEST_DIR, 'logs', 'vellum.log'),
  getHistoryPath: () => join(TEST_DIR, 'history'),
  getHooksDir: () => join(TEST_DIR, 'hooks'),
  getIpcBlobDir: () => join(TEST_DIR, 'ipc-blobs'),
  getSandboxRootDir: () => join(TEST_DIR, 'sandbox'),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, 'interfaces'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
  migratePath: () => {},
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    sandbox: { enabled: false, backend: 'local' },
  }),
}));

// ── Import after mocks ───────────────────────────────────────────────
const { buildSystemPrompt } = await import('../config/system-prompt.js');

// Load task_list_add description from the bundled skill TOOLS.json
const tasksToolsJson = JSON.parse(
  readFileSync(join(import.meta.dirname, '../config/bundled-skills/tasks/TOOLS.json'), 'utf-8'),
);
const taskListAddDef = tasksToolsJson.tools.find((t: { name: string }) => t.name === 'task_list_add');

// Load reminder_create description from the bundled skill TOOLS.json
const reminderToolsJson = JSON.parse(
  readFileSync(join(import.meta.dirname, '../config/bundled-skills/reminder/TOOLS.json'), 'utf-8'),
);
const reminderCreateDef = reminderToolsJson.tools.find((t: { name: string }) => t.name === 'reminder_create');

// schedule_create is registered via side-effect import; import the module
// to access the tool description through the registry.
await import('../tools/schedule/create.js');
const { getTool } = await import('../tools/registry.js');

// =====================================================================
// 1. System prompt: buildTaskScheduleReminderRoutingSection
// =====================================================================

describe('Task/Schedule/Reminder routing section in system prompt', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('system prompt includes the routing section heading', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('## Tool Routing: Tasks vs Schedules vs Reminders');
  });

  test('routing section explains all three subsystems', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('### Task Queue (task_list_add / task_list_show / task_list_update / task_list_remove)');
    expect(prompt).toContain('### Schedules (schedule_create / schedule_list / schedule_update / schedule_delete)');
    expect(prompt).toContain('### Reminders (reminder)');
  });

  test('routing section contains key routing phrases for task queue', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"Add to my tasks"');
    expect(prompt).toContain('"add to my queue"');
    expect(prompt).toContain('"put this on my task list"');
  });

  test('routing section explains ad-hoc work item creation', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('ad-hoc work items');
    expect(prompt).toContain('just a `title`');
    expect(prompt).toContain('no existing task template is needed');
  });

  test('routing section clarifies schedules are for recurring automation only', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('recurring automated jobs');
    expect(prompt).toContain('cron schedule');
    expect(prompt).toContain('ONLY when the user explicitly wants');
  });

  test('routing section clarifies reminders are for time-triggered notifications', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('one-time time-triggered notifications');
    expect(prompt).toContain('"remind me at 3pm"');
  });

  test('routing section includes common mistakes to avoid', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('### Common mistakes to avoid');
    // The key mis-routing guard: "add this to my tasks" should go to task_list_add
    expect(prompt).toContain('"Add this to my tasks" → task_list_add (NOT schedule_create or reminder)');
  });

  test('routing section distinguishes timed vs untimed "remind me"', () => {
    const prompt = buildSystemPrompt();
    // Without a time → task queue
    expect(prompt).toContain('"Remind me to buy groceries" without a time → task_list_add');
    // With a time → reminder
    expect(prompt).toContain('"Remind me at 5pm to buy groceries" → reminder');
  });

  test('routing section appears after tool routing by content type', () => {
    const prompt = buildSystemPrompt();
    const contentTypeIdx = prompt.indexOf('## Tool Routing by Content Type');
    const taskRoutingIdx = prompt.indexOf('## Tool Routing: Tasks vs Schedules vs Reminders');
    // Both must be present
    expect(contentTypeIdx).toBeGreaterThanOrEqual(0);
    expect(taskRoutingIdx).toBeGreaterThan(contentTypeIdx);
  });
});

// =====================================================================
// 2. Tool description content: routing keywords
// =====================================================================

describe('task_list_add tool description', () => {
  test('mentions "add to my tasks" routing phrase', () => {
    const def = taskListAddDef;
    expect(def.description).toContain('add to my tasks');
  });

  test('mentions "add to my queue" routing phrase', () => {
    const def = taskListAddDef;
    expect(def.description).toContain('add to my queue');
  });

  test('mentions "put this on my task list" routing phrase', () => {
    const def = taskListAddDef;
    expect(def.description).toContain('put this on my task list');
  });

  test('mentions ad-hoc title-only mode', () => {
    const def = taskListAddDef;
    expect(def.description).toContain('just a title');
  });

  test('explicitly warns NOT to use schedule_create or reminder for task requests', () => {
    const def = taskListAddDef;
    expect(def.description).toContain('Do NOT use schedule_create or reminder');
  });
});

describe('schedule_create tool description', () => {
  test('mentions recurring scheduled automation', () => {
    const tool = getTool('schedule_create');
    expect(tool).toBeDefined();
    const def = tool!.getDefinition();
    expect(def.description).toContain('recurring');
  });

  test('mentions cron interval', () => {
    const tool = getTool('schedule_create');
    const def = tool!.getDefinition();
    expect(def.description).toContain('cron');
  });

  test('warns against using for "add to my tasks" requests', () => {
    const tool = getTool('schedule_create');
    const def = tool!.getDefinition();
    expect(def.description).toContain('Do NOT use this for "add to my tasks"');
  });

  test('redirects to task_list_add for task queue items', () => {
    const tool = getTool('schedule_create');
    const def = tool!.getDefinition();
    expect(def.description).toContain('task_list_add');
  });

  test('does NOT suggest it handles task queue items', () => {
    const tool = getTool('schedule_create');
    const def = tool!.getDefinition();
    // Should not claim to handle one-off task items
    expect(def.description).not.toContain('task queue');
    expect(def.description).not.toContain('one-off');
  });
});

describe('reminder tool description', () => {
  test('mentions time-based reminders', () => {
    expect(reminderCreateDef.description).toContain('time-based reminder');
  });

  test('scopes to time-triggered notifications only', () => {
    expect(reminderCreateDef.description).toContain('ONLY when the user wants a time-triggered notification');
  });

  test('warns against using for "add to my tasks" requests', () => {
    expect(reminderCreateDef.description).toContain('Do NOT use this for "add to my tasks"');
  });

  test('redirects to task_list_add for task queue items', () => {
    expect(reminderCreateDef.description).toContain('task_list_add');
  });
});

// =====================================================================
// 3. Cross-tool consistency: all three tools agree on routing boundaries
// =====================================================================

describe('cross-tool routing consistency', () => {
  test('all three tools reference task_list_add as the task-queue tool', () => {
    const enqueueDef = taskListAddDef;
    const scheduleTool = getTool('schedule_create')!;
    const scheduleDef = scheduleTool.getDefinition();

    // task_list_add is the canonical name in all three descriptions
    expect(enqueueDef.name).toBe('task_list_add');
    expect(scheduleDef.description).toContain('task_list_add');
    expect(reminderCreateDef.description).toContain('task_list_add');
  });

  test('schedule_create and reminder both reject "add to my queue" usage', () => {
    const scheduleTool = getTool('schedule_create')!;
    const scheduleDef = scheduleTool.getDefinition();

    // Both should redirect away from task-queue requests
    expect(scheduleDef.description).toContain('add to my queue');
    expect(reminderCreateDef.description).toContain('add to my queue');
  });
});
