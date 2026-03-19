/**
 * Tests for the bootstrap onboarding gate in buildSystemPrompt().
 *
 * Verifies that BOOTSTRAP.md is included only when the user has never
 * chatted before (no conversations with user messages).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = join(tmpdir(), `vellum-bootstrap-test-${crypto.randomUUID()}`);

let mockConversationCount = 0;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../../util/platform.js");
mock.module("../../util/platform.js", () => ({
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

mock.module("../../util/logger.js", () => ({
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    assistantFeatureFlagValues: {},
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
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

mock.module("../../memory/conversation-queries.js", () => ({
  countConversationsWithUserMessages: () => mockConversationCount,
}));

mock.module("../../oauth/oauth-store.js", () => ({
  listConnections: () => [],
}));

mock.module("../../config/env-registry.js", () => ({
  getIsContainerized: () => false,
  getBaseDataDir: () => TEST_DIR,
}));

const { buildSystemPrompt } = await import("../system-prompt.js");

describe("bootstrap onboarding gate", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Write a minimal SOUL.md so the prompt always has some content
    writeFileSync(join(TEST_DIR, "SOUL.md"), "You are a helpful assistant.");
  });

  afterEach(() => {
    mockConversationCount = 0;
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("includes bootstrap when no prior conversations have user messages", () => {
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "Welcome! Let's get set up.");
    mockConversationCount = 0;

    const result = buildSystemPrompt();

    expect(result).toContain("First-Run Ritual");
    expect(result).toContain("Welcome! Let's get set up.");
  });

  test("excludes bootstrap when prior conversations have user messages", () => {
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "Welcome! Let's get set up.");
    mockConversationCount = 1;

    const result = buildSystemPrompt();

    expect(result).not.toContain("First-Run Ritual");
    expect(result).not.toContain("Welcome! Let's get set up.");
  });

  test("excludes bootstrap when many prior conversations exist", () => {
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "Welcome! Let's get set up.");
    mockConversationCount = 10;

    const result = buildSystemPrompt();

    expect(result).not.toContain("First-Run Ritual");
  });

  test("excludes bootstrap when BOOTSTRAP.md does not exist, even with zero conversations", () => {
    // No BOOTSTRAP.md written
    mockConversationCount = 0;

    const result = buildSystemPrompt();

    expect(result).not.toContain("First-Run Ritual");
  });

  test("excludes bootstrap when excludeBootstrap option is set", () => {
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "Welcome! Let's get set up.");
    mockConversationCount = 0;

    const result = buildSystemPrompt({ excludeBootstrap: true });

    expect(result).not.toContain("First-Run Ritual");
  });

  test("notification-only conversations (no user messages) do not suppress bootstrap", () => {
    // Simulate: notification conversations exist but none have user messages.
    // countConversationsWithUserMessages returns 0 because it only counts
    // conversations with role='user' messages.
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "Welcome! Let's get set up.");
    mockConversationCount = 0;

    const result = buildSystemPrompt();

    expect(result).toContain("First-Run Ritual");
    expect(result).toContain("Welcome! Let's get set up.");
  });
});
