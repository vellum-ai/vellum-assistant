import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock platform to isolate tests from the real workspace ────────────
const TEST_DIR = join(tmpdir(), `vellum-routing-test-${crypto.randomUUID()}`);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  getWorkspaceDir: () => TEST_DIR,
  getWorkspaceConfigPath: () => join(TEST_DIR, "config.json"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "hooks"),
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, "vellum.sock"),
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getHooksDir: () => join(TEST_DIR, "hooks"),
  getIpcBlobDir: () => join(TEST_DIR, "ipc-blobs"),
  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  readSessionToken: () => null,
  removeSocketFile: () => {},
}));

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  isDebug: () => false,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    sandbox: { enabled: false, backend: "local" },
    assistantFeatureFlagValues: {
      "feature_flags.guardian-verify-setup.enabled": true,
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  syncConfigToLockfile: () => {},
}));

// ── Import after mocks ───────────────────────────────────────────────
const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

// Load task_list_add description from the bundled skill TOOLS.json
const tasksToolsJson = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../skills/bundled-skills/tasks/TOOLS.json"),
    "utf-8",
  ),
);
const taskListAddDef = tasksToolsJson.tools.find(
  (t: { name: string }) => t.name === "task_list_add",
);

// Load reminder_create description from the bundled skill TOOLS.json
const reminderToolsJson = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../skills/bundled-skills/reminder/TOOLS.json"),
    "utf-8",
  ),
);
const reminderCreateDef = reminderToolsJson.tools.find(
  (t: { name: string }) => t.name === "reminder_create",
);

// Load schedule_create description from the bundled skill TOOLS.json
const scheduleToolsJson = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../skills/bundled-skills/schedule/TOOLS.json"),
    "utf-8",
  ),
);
const scheduleCreateDef = scheduleToolsJson.tools.find(
  (t: { name: string }) => t.name === "schedule_create",
);

// =====================================================================
// 1. System prompt: buildTaskScheduleReminderRoutingSection
// =====================================================================

describe("Task/Schedule/Reminder routing section in system prompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("system prompt includes the routing section heading", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "## Tool Routing: Tasks vs Schedules vs Reminders vs Notifications",
    );
  });

  test("routing section lists all four tools in the summary table", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("`task_list_add`");
    expect(prompt).toContain("`schedule_create`");
    expect(prompt).toContain("`reminder_create`");
    expect(prompt).toContain("`send_notification`");
  });

  test("routing section warns that send_notification is immediate-only", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("send_notification` is immediate-only");
    expect(prompt).toContain("fires NOW");
  });

  test("routing section includes quick routing rules", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Quick routing rules");
    expect(prompt).toContain("Future time, one-shot");
    expect(prompt).toContain("Recurring pattern");
    expect(prompt).toContain("No time, track as work");
  });

  test("routing section documents entity type routing", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(
      "Entity type routing: work items vs task templates",
    );
    expect(prompt).toContain("**Work items**");
    expect(prompt).toContain("**Task templates**");
  });

  test("routing section references the Time-Based Actions skill", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("Time-Based Actions");
  });

  test("routing section is present in the system prompt", () => {
    const prompt = buildSystemPrompt();
    const taskRoutingIdx = prompt.indexOf(
      "## Tool Routing: Tasks vs Schedules vs Reminders vs Notifications",
    );
    expect(taskRoutingIdx).toBeGreaterThanOrEqual(0);
  });
});

// =====================================================================
// 2. Tool description content: routing keywords
// =====================================================================

describe("task_list_add tool description", () => {
  test('mentions "add to my tasks" routing phrase', () => {
    const def = taskListAddDef;
    expect(def.description).toContain("add to my tasks");
  });

  test('mentions "add to my queue" routing phrase', () => {
    const def = taskListAddDef;
    expect(def.description).toContain("add to my queue");
  });

  test('mentions "put this on my task list" routing phrase', () => {
    const def = taskListAddDef;
    expect(def.description).toContain("put this on my task list");
  });

  test("mentions ad-hoc title-only mode", () => {
    const def = taskListAddDef;
    expect(def.description).toContain("just a title");
  });

  test("explicitly warns NOT to use schedule_create or reminder for task requests", () => {
    const def = taskListAddDef;
    expect(def.description).toContain("Do NOT use schedule_create or reminder");
  });
});

describe("schedule_create tool description", () => {
  test("mentions recurring scheduled automation", () => {
    expect(scheduleCreateDef).toBeDefined();
    expect(scheduleCreateDef.description).toContain("recurring");
  });

  test("mentions cron interval", () => {
    expect(scheduleCreateDef.description).toContain("cron");
  });

  test('warns against using for "add to my tasks" requests', () => {
    expect(scheduleCreateDef.description).toContain(
      'Do NOT use this for "add to my tasks"',
    );
  });

  test("redirects to task_list_add for task queue items", () => {
    expect(scheduleCreateDef.description).toContain("task_list_add");
  });

  test("does NOT suggest it handles task queue items", () => {
    expect(scheduleCreateDef.description).not.toContain("task queue");
    expect(scheduleCreateDef.description).not.toContain("one-off");
  });
});

describe("reminder tool description", () => {
  test("mentions time-based reminders", () => {
    expect(reminderCreateDef.description).toContain("time-based reminder");
  });

  test("scopes to time-triggered notifications only", () => {
    expect(reminderCreateDef.description).toContain(
      "ONLY when the user wants a time-triggered notification",
    );
  });

  test('warns against using for "add to my tasks" requests', () => {
    expect(reminderCreateDef.description).toContain(
      'Do NOT use this for "add to my tasks"',
    );
  });

  test("redirects to task_list_add for task queue items", () => {
    expect(reminderCreateDef.description).toContain("task_list_add");
  });
});

// =====================================================================
// 3. Cross-tool consistency: all three tools agree on routing boundaries
// =====================================================================

describe("cross-tool routing consistency", () => {
  test("all three tools reference task_list_add as the task-queue tool", () => {
    // task_list_add is the canonical name in all three descriptions
    expect(taskListAddDef.name).toBe("task_list_add");
    expect(scheduleCreateDef.description).toContain("task_list_add");
    expect(reminderCreateDef.description).toContain("task_list_add");
  });

  test('schedule_create and reminder both reject "add to my queue" usage', () => {
    // Both should redirect away from task-queue requests
    expect(scheduleCreateDef.description).toContain("add to my queue");
    expect(reminderCreateDef.description).toContain("add to my queue");
  });
});

// =====================================================================
// 4. Guardian verification routing section in system prompt
// =====================================================================

describe("Guardian verification routing section in system prompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("system prompt includes the guardian verification routing heading", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("## Routing: Guardian Verification");
  });

  test('routing section includes trigger phrase "verify guardian"', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("verify guardian");
  });

  test("routing section does not include legacy channel trigger phrases", () => {
    const prompt = buildSystemPrompt();
    // Verify no legacy channel trigger phrases remain in the routing section
    expect(prompt).not.toContain("set guardian for");
  });

  test('routing section includes trigger phrase "verify my Telegram account"', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("verify my Telegram account");
  });

  test('routing section includes trigger phrase "verify phone channel"', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("verify phone channel");
  });

  test('routing section includes trigger phrase "verify my phone number"', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("verify my phone number");
  });

  test('routing section includes trigger phrase "set up guardian verification"', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("set up guardian verification");
  });

  test("routing section references the guardian-verify-setup skill", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("guardian-verify-setup");
  });

  test("routing section mentions phone and telegram channels but not legacy channels", () => {
    const prompt = buildSystemPrompt();
    const routingStart = prompt.indexOf("## Routing: Guardian Verification");
    const routingSection = prompt.substring(routingStart, routingStart + 1000);
    expect(routingSection).toContain("phone");
    expect(routingSection).toContain("telegram");
  });

  test("routing section contains exclusivity wording", () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    // Must contain "exclusively" or "must only" to enforce exclusive handling
    expect(lower.includes("exclusively") || lower.includes("must only")).toBe(
      true,
    );
  });

  test("routing section prohibits loading phone-calls for guardian verification", () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    // Must explicitly prohibit phone-calls for guardian verification intents
    expect(lower).toContain("do not load");
    expect(lower).toContain("phone-calls");
  });

  test("routing section includes channel-preservation guidance", () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    // Must advise not to re-ask channel if already specified
    expect(
      lower.includes("do not re-ask") || lower.includes("already specified"),
    ).toBe(true);
  });

  test('routing section disambiguates "set myself up as your guardian" phrasing', () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("help me set myself up as your guardian");
    expect(lower).toContain("asking to verify themselves as guardian");
  });

  test("routing section discourages conceptual detours for direct setup requests", () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("do not give conceptual");
    expect(lower).toContain("unless the user explicitly asks");
  });
});
