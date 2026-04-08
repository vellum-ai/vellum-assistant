import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realUserReference = require("../prompts/user-reference.js");
mock.module("../prompts/user-reference.js", () => ({
  ...realUserReference,
  resolveUserReference: () => "John",
  resolveUserPronouns: () => null,
}));

const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

const SOUL_PATH = join(TEST_DIR, "SOUL.md");

afterAll(() => {
  mock.restore();
});

describe("system prompt no longer injects ask-before-acting mode", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(SOUL_PATH, "# Soul\n\nSOUL guidance survives.");
  });

  afterEach(() => {
    try {
      rmSync(SOUL_PATH, { force: true });
    } catch {
      /* noop */
    }
  });

  test("includes SOUL.md and does not inject action confirmation copy", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("SOUL guidance survives.");
    expect(prompt).not.toContain("Action Confirmation Mode");
  });
});
