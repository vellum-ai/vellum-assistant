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

// Load schedule_create description from the bundled skill TOOLS.json
const scheduleToolsJson = JSON.parse(
  readFileSync(join(import.meta.dirname, '../config/bundled-skills/schedule/TOOLS.json'), 'utf-8'),
);
const scheduleCreateDef = scheduleToolsJson.tools.find((t: { name: string }) => t.name === 'schedule_create');

// =====================================================================
// 1. Tasks SKILL.md: routing section (moved from system prompt)
// =====================================================================

const tasksSkillMd = readFileSync(
  join(import.meta.dirname, '../config/bundled-skills/tasks/SKILL.md'),
  'utf-8',
);

describe('Task/Schedule/Reminder routing section in tasks SKILL.md', () => {
  test('SKILL.md includes the routing section heading', () => {
    expect(tasksSkillMd).toContain('## Tool Routing: Tasks vs Schedules vs Reminders');
  });

  test('routing section explains all three subsystems', () => {
    expect(tasksSkillMd).toContain('### Task Queue (task_list_add / task_list_show / task_list_update / task_list_remove)');
    expect(tasksSkillMd).toContain('### Schedules (schedule_create / schedule_list / schedule_update / schedule_delete)');
    expect(tasksSkillMd).toContain('### Reminders (reminder_create / reminder_list / reminder_cancel)');
  });

  test('routing section contains key routing phrases for task queue', () => {
    expect(tasksSkillMd).toContain('"Add to my tasks"');
    expect(tasksSkillMd).toContain('"add to my queue"');
    expect(tasksSkillMd).toContain('"put this on my task list"');
  });

  test('routing section includes common mistakes to avoid', () => {
    expect(tasksSkillMd).toContain('### Common mistakes to avoid');
    expect(tasksSkillMd).toContain('task_list_add (NOT schedule_create or reminder_create)');
  });

  test('routing section documents RRULE set constructs', () => {
    expect(tasksSkillMd).toContain('#### RRULE Set Constructs');
    expect(tasksSkillMd).toContain('**RDATE**');
    expect(tasksSkillMd).toContain('**EXDATE**');
    expect(tasksSkillMd).toContain('**EXRULE**');
  });

  test('routing section distinguishes timed vs untimed "remind me"', () => {
    expect(tasksSkillMd).toContain('"Remind me to buy groceries" without a time');
    expect(tasksSkillMd).toContain('"Remind me at 5pm to buy groceries" → reminder_create');
  });

  test('routing section documents entity type routing', () => {
    expect(tasksSkillMd).toContain('### Entity type routing: work items vs task templates');
    expect(tasksSkillMd).toContain('Do NOT pass a work item ID to a task template tool');
  });

  test('system prompt does NOT include routing section (moved to skill)', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    try {
      const prompt = buildSystemPrompt();
      expect(prompt).not.toContain('## Tool Routing: Tasks vs Schedules vs Reminders');
    } finally {
      if (existsSync(TEST_DIR)) {
        rmSync(TEST_DIR, { recursive: true, force: true });
      }
    }
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
    expect(scheduleCreateDef).toBeDefined();
    expect(scheduleCreateDef.description).toContain('recurring');
  });

  test('mentions cron interval', () => {
    expect(scheduleCreateDef.description).toContain('cron');
  });

  test('warns against using for "add to my tasks" requests', () => {
    expect(scheduleCreateDef.description).toContain('Do NOT use this for "add to my tasks"');
  });

  test('redirects to task_list_add for task queue items', () => {
    expect(scheduleCreateDef.description).toContain('task_list_add');
  });

  test('does NOT suggest it handles task queue items', () => {
    expect(scheduleCreateDef.description).not.toContain('task queue');
    expect(scheduleCreateDef.description).not.toContain('one-off');
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
    // task_list_add is the canonical name in all three descriptions
    expect(taskListAddDef.name).toBe('task_list_add');
    expect(scheduleCreateDef.description).toContain('task_list_add');
    expect(reminderCreateDef.description).toContain('task_list_add');
  });

  test('schedule_create and reminder both reject "add to my queue" usage', () => {
    // Both should redirect away from task-queue requests
    expect(scheduleCreateDef.description).toContain('add to my queue');
    expect(reminderCreateDef.description).toContain('add to my queue');
  });
});
