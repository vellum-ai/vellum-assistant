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

// =====================================================================
// 1. System prompt: task/schedule/notification dispatch hints
// =====================================================================

describe("Task/Schedule routing dispatch hints in system prompt", () => {
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
      "## Tool Routing: Tasks vs Schedules vs Notifications",
    );
  });

  test("routing section lists all three tools as dispatch hints", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("`task_list_add`");
    expect(prompt).toContain("`schedule_create`");
    expect(prompt).toContain("`send_notification`");
  });

  test("routing section warns that send_notification is immediate-only", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("immediate-only");
    expect(prompt).toContain("fires NOW");
  });

  test("routing section references the time-based-actions skill for full framework", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("time-based-actions");
  });

  test("routing section mentions fire_at for one-shot schedules", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("fire_at");
  });

  test("routing section is compact -- no verbose decision tree or entity type routing", () => {
    const prompt = buildSystemPrompt();
    // These details now live in the time-based-actions skill, not the global prompt
    expect(prompt).not.toContain("### Quick routing rules");
    expect(prompt).not.toContain(
      "### Entity type routing: work items vs task templates",
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
// 4. Guardian verification routing dispatch hint in system prompt
// =====================================================================

describe("Guardian verification routing dispatch hint in system prompt", () => {
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

  test("routing section references the guardian-verify-setup skill", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("guardian-verify-setup");
  });

  test("routing section directs to load the skill exclusively", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("exclusively");
  });

  test("routing section prohibits loading phone-calls for verification intents", () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("do not load");
    expect(lower).toContain("phone-calls");
  });

  test("routing section advises not to re-ask channel if already specified", () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("do not re-ask");
  });

  test('routing section disambiguates "set myself up as your guardian" phrasing', () => {
    const prompt = buildSystemPrompt();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("help me set myself up as your guardian");
  });

  test("routing section is compact -- detailed steps live in the skill", () => {
    const prompt = buildSystemPrompt();
    // These details now live in the guardian-verify-setup skill, not the global prompt
    expect(prompt).not.toContain("### Trigger phrases");
    expect(prompt).not.toContain("### What it does");
    expect(prompt).not.toContain("### Exclusivity rules");
  });
});

// =====================================================================
// 5. Guardian-verify-setup skill contains relocated detail
// =====================================================================

describe("guardian-verify-setup SKILL.md contains routing detail", () => {
  const skillContent = readFileSync(
    join(import.meta.dirname, "../../../skills/guardian-verify-setup/SKILL.md"),
    "utf-8",
  );

  test("skill has trigger phrases section", () => {
    expect(skillContent).toContain("## Trigger Phrases");
    expect(skillContent).toContain("verify guardian");
    expect(skillContent).toContain("verify my Telegram account");
    expect(skillContent).toContain("verify phone channel");
  });

  test("skill has exclusivity rules section", () => {
    expect(skillContent).toContain("## Exclusivity Rules");
    expect(skillContent).toContain("load it exclusively");
    expect(skillContent).toContain("Do NOT load `phone-calls`");
  });

  test("skill has channel-preservation guidance", () => {
    expect(skillContent).toContain("do not re-ask which channel");
  });
});

// =====================================================================
// 6. Phone-calls SKILL.md contains relocated detail
// =====================================================================

describe("phone-calls SKILL.md contains routing detail", () => {
  const skillContent = readFileSync(
    join(
      import.meta.dirname,
      "../config/bundled-skills/phone-calls/SKILL.md",
    ),
    "utf-8",
  );

  test("skill has trigger phrases section", () => {
    expect(skillContent).toContain("## Trigger Phrases");
    expect(skillContent).toContain("Set up phone calling");
    expect(skillContent).toContain("Make a call to");
  });

  test("skill has exclusivity rules section", () => {
    expect(skillContent).toContain("## Exclusivity Rules");
    expect(skillContent).toContain("Do NOT improvise Twilio setup");
    expect(skillContent).toContain("guardian-verify-setup");
  });
});

// =====================================================================
// 7. Voice-setup SKILL.md contains relocated detail
// =====================================================================

describe("voice-setup SKILL.md contains routing detail", () => {
  const skillContent = readFileSync(
    join(import.meta.dirname, "../../../skills/voice-setup/SKILL.md"),
    "utf-8",
  );

  test("skill has trigger phrases section", () => {
    expect(skillContent).toContain("## Trigger Phrases");
    expect(skillContent).toContain("Help me set up voice");
    expect(skillContent).toContain("PTT isn't working");
  });

  test("skill has disambiguation section", () => {
    expect(skillContent).toContain("## Disambiguation");
    expect(skillContent).toContain("local PTT, wake word, microphone permissions");
    expect(skillContent).toContain("Twilio-powered voice calls");
  });
});

// =====================================================================
// 8. Time-based-actions SKILL.md is current (no stale reminder_create)
// =====================================================================

describe("time-based-actions SKILL.md is up to date", () => {
  const skillContent = readFileSync(
    join(
      import.meta.dirname,
      "../../../skills/time-based-actions/SKILL.md",
    ),
    "utf-8",
  );

  test("does not reference the removed reminder_create tool", () => {
    expect(skillContent).not.toContain("reminder_create");
  });

  test("uses schedule_create with fire_at for one-shot reminders", () => {
    expect(skillContent).toContain("schedule_create");
    expect(skillContent).toContain("fire_at");
  });

  test("warns that send_notification is immediate-only", () => {
    expect(skillContent).toContain("IMMEDIATE-ONLY");
  });

  test("includes entity type routing guidance", () => {
    expect(skillContent).toContain("Entity Type Routing");
    expect(skillContent).toContain("Work items");
    expect(skillContent).toContain("Task templates");
  });

  test("includes relative time parsing guidance", () => {
    expect(skillContent).toContain("Relative Time Parsing");
    expect(skillContent).toContain("Anchored & Ambiguous Relative Time");
  });
});
