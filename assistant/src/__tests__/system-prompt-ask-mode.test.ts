/**
 * Tests for the "Action Confirmation Mode" system prompt injection.
 *
 * Verifies:
 *   - Prompt includes the section when `permission-controls-v2` flag is enabled
 *     AND `askBeforeActing` is `true`.
 *   - Prompt excludes the section when the flag is disabled.
 *   - Prompt excludes the section when `askBeforeActing` is `false`.
 */
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock platform to use a temp directory
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

// ---------------------------------------------------------------------------
// Controllable mocks for feature flags and permission mode
// ---------------------------------------------------------------------------

let flagEnabled = false;
let askBeforeActing = true;

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) => {
    if (key === "permission-controls-v2") return flagEnabled;
    return true;
  },
  _setOverridesForTesting: () => {},
  clearFeatureFlagOverridesCache: () => {},
  getAssistantFeatureFlagDefaults: () => ({}),
}));

mock.module("../permissions/permission-mode-store.js", () => ({
  getMode: () => ({ askBeforeActing, hostAccess: false }),
  initPermissionModeStore: () => {},
  setAskBeforeActing: () => {},
  setHostAccess: () => {},
  onModeChanged: () => () => {},
  resetForTesting: () => {},
}));

// Import after mocks
const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

const ACTION_CONFIRMATION_HEADING = "## Action Confirmation Mode";

describe("Action Confirmation Mode system prompt injection", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    flagEnabled = false;
    askBeforeActing = true;
  });

  afterEach(() => {
    flagEnabled = false;
    askBeforeActing = true;
  });

  test("includes section when flag enabled and askBeforeActing is true", () => {
    flagEnabled = true;
    askBeforeActing = true;
    const result = buildSystemPrompt();
    expect(result).toContain(ACTION_CONFIRMATION_HEADING);
    expect(result).toContain('"Ask before acting" mode');
  });

  test("excludes section when flag is disabled", () => {
    flagEnabled = false;
    askBeforeActing = true;
    const result = buildSystemPrompt();
    expect(result).not.toContain(ACTION_CONFIRMATION_HEADING);
  });

  test("excludes section when askBeforeActing is false", () => {
    flagEnabled = true;
    askBeforeActing = false;
    const result = buildSystemPrompt();
    expect(result).not.toContain(ACTION_CONFIRMATION_HEADING);
  });

  test("excludes section when both flag disabled and askBeforeActing false", () => {
    flagEnabled = false;
    askBeforeActing = false;
    const result = buildSystemPrompt();
    expect(result).not.toContain(ACTION_CONFIRMATION_HEADING);
  });
});
