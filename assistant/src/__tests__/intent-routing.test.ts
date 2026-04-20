import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

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
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// ── Import after mocks ───────────────────────────────────────────────
const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

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
  test("schedule_create redirects task requests to task_list_add", () => {
    expect(scheduleCreateDef.description).toContain("task_list_add");
  });

  test('schedule_create rejects "add to my queue" usage', () => {
    expect(scheduleCreateDef.description).toContain("add to my queue");
  });
});

// =====================================================================
// 4. Activation hints in skills catalog (replaces domain routing sections)
// =====================================================================

describe("Skills catalog and routing sections removed from system prompt", () => {
  test("domain routing sections are no longer in system prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("## Routing: Guardian Verification");
    expect(prompt).not.toContain("## Routing: Phone Calls");
    expect(prompt).not.toContain("## Routing: Voice Setup");
    expect(prompt).not.toContain("## Routing: Starter Tasks");
  });

  test("skills catalog is no longer in system prompt", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("## Available Skills");
  });
});
