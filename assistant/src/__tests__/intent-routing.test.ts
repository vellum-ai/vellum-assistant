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
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getHooksDir: () => join(TEST_DIR, "hooks"),

  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  readSessionToken: () => null,
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
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    sandbox: { enabled: false, backend: "local" },
    assistantFeatureFlagValues: {},
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-2.5-flash-image",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
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
    join(import.meta.dirname, "../config/bundled-skills/tasks/TOOLS.json"),
    "utf-8",
  ),
);
const taskListAddDef = tasksToolsJson.tools.find(
  (t: { name: string }) => t.name === "task_list_add",
);

// Load schedule_create description from the bundled skill TOOLS.json
const scheduleToolsJson = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../config/bundled-skills/schedule/TOOLS.json"),
    "utf-8",
  ),
);
const scheduleCreateDef = scheduleToolsJson.tools.find(
  (t: { name: string }) => t.name === "schedule_create",
);

// Load send_notification description from the bundled skill TOOLS.json
const notifToolsJson = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "../config/bundled-skills/notifications/TOOLS.json",
    ),
    "utf-8",
  ),
);
const sendNotificationDef = notifToolsJson.tools.find(
  (t: { name: string }) => t.name === "send_notification",
);

// =====================================================================
// 1. Routing section removed from system prompt — guidance in tool descriptions
// =====================================================================

describe("Task/Schedule routing NOT in system prompt (moved to tool descriptions)", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("system prompt does not contain the old routing section", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain(
      "## Tool Routing: Tasks vs Schedules vs Notifications",
    );
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

describe("send_notification tool description", () => {
  test("states it fires immediately with no delay", () => {
    expect(sendNotificationDef).toBeDefined();
    expect(sendNotificationDef.description).toContain("immediate");
    expect(sendNotificationDef.description).toContain("no delay");
  });

  test("redirects to schedule_create for future alerts", () => {
    expect(sendNotificationDef.description).toContain("schedule_create");
  });
});

// =====================================================================
// 3. Cross-tool consistency: schedule and task tools agree on routing boundaries
// =====================================================================

describe("cross-tool routing consistency", () => {
  test("both tools reference task_list_add as the task-queue tool", () => {
    expect(taskListAddDef.name).toBe("task_list_add");
    expect(scheduleCreateDef.description).toContain("task_list_add");
  });

  test('schedule_create rejects "add to my queue" usage', () => {
    expect(scheduleCreateDef.description).toContain("add to my queue");
  });
});

// =====================================================================
// 4. Activation hints in <available_skills> XML (replaces domain routing sections)
// =====================================================================

describe("Activation hints in available_skills XML", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("available_skills XML does NOT contain location attribute", () => {
    const prompt = buildSystemPrompt();
    const start = prompt.indexOf("<available_skills>");
    const end = prompt.indexOf("</available_skills>");
    expect(start).not.toBe(-1);
    expect(end).not.toBe(-1);
    const skillsXml = prompt.substring(start, end);
    expect(skillsXml).not.toContain("location=");
  });

  test("phone-calls bundled skill has hints and avoid-when attributes in XML", () => {
    const prompt = buildSystemPrompt();
    const start = prompt.indexOf("<available_skills>");
    const end = prompt.indexOf("</available_skills>");
    expect(start).not.toBe(-1);
    expect(end).not.toBe(-1);
    const skillsXml = prompt.substring(start, end);
    expect(skillsXml).toContain('id="phone-calls"');
    const skillLine = skillsXml
      .split("\n")
      .find((l) => l.includes('id="phone-calls"'));
    expect(skillLine).toBeDefined();
    expect(skillLine).toContain("hints=");
    expect(skillLine).toContain("avoid-when=");
  });

  test("orchestration bundled skill has hints and avoid-when attributes in XML", () => {
    const prompt = buildSystemPrompt();
    const start = prompt.indexOf("<available_skills>");
    const end = prompt.indexOf("</available_skills>");
    expect(start).not.toBe(-1);
    expect(end).not.toBe(-1);
    const skillsXml = prompt.substring(start, end);
    expect(skillsXml).toContain('id="orchestration"');
    const skillLine = skillsXml
      .split("\n")
      .find((l) => l.includes('id="orchestration"'));
    expect(skillLine).toBeDefined();
    expect(skillLine).toContain("hints=");
    expect(skillLine).toContain("avoid-when=");
  });

  test("browser bundled skill has hints attribute in XML", () => {
    const prompt = buildSystemPrompt();
    const start = prompt.indexOf("<available_skills>");
    const end = prompt.indexOf("</available_skills>");
    expect(start).not.toBe(-1);
    expect(end).not.toBe(-1);
    const skillsXml = prompt.substring(start, end);
    expect(skillsXml).toContain('id="browser"');
    const skillLine = skillsXml
      .split("\n")
      .find((l) => l.includes('id="browser"'));
    expect(skillLine).toBeDefined();
    expect(skillLine).toContain("hints=");
  });

  test("domain routing sections are no longer in system prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("## Routing: Guardian Verification");
    expect(prompt).not.toContain("## Routing: Phone Calls");
    expect(prompt).not.toContain("## Routing: Voice Setup");
    expect(prompt).not.toContain("## Routing: Starter Tasks");
  });
});
