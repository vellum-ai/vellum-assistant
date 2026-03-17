/**
 * Integration tests for assistant feature flag enforcement at system prompt,
 * skill_load, and session-skill-tools projection layers.
 *
 * Covers:
 *   - Flag OFF blocks all exposure paths
 *   - Missing persisted value falls back to code default
 *   - New assistantFeatureFlagValues is the sole override mechanism
 *   - Undeclared keys default to enabled
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test-scoped temp directory and config state
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-asst-flags-test-${crypto.randomUUID()}`,
);

let currentConfig: Record<string, unknown> = {
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
};

const DECLARED_FLAG_ID = "contacts";
const DECLARED_FLAG_KEY = `feature_flags.${DECLARED_FLAG_ID}.enabled`;
const DECLARED_SKILL_ID = "contacts";

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
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  getPlatformName: () => "linux",
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
  getConfig: () => currentConfig,
  loadConfig: () => currentConfig,
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  syncConfigToLockfile: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realUserReference = require("../prompts/user-reference.js");
mock.module("../prompts/user-reference.js", () => ({
  ...realUserReference,
  resolveUserReference: () => "TestUser",
  resolveUserPronouns: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realCredentialMetadataStore = require("../tools/credentials/metadata-store.js");
mock.module("../tools/credentials/metadata-store.js", () => ({
  ...realCredentialMetadataStore,
  listCredentialMetadata: () => [],
}));

const { buildSystemPrompt } = await import("../prompts/system-prompt.js");
const { isAssistantFeatureFlagEnabled } =
  await import("../config/assistant-feature-flags.js");
const { skillFlagKey } = await import("../config/skill-state.js");

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  currentConfig = {
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
  };
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSkillOnDisk(
  id: string,
  name: string,
  description: string,
  featureFlag?: string,
): void {
  const skillsDir = join(TEST_DIR, "skills");
  mkdirSync(join(skillsDir, id), { recursive: true });
  const ffBlock = featureFlag
    ? `\nmetadata: {"vellum":{"feature-flag":"${featureFlag}"}}`
    : "";
  writeFileSync(
    join(skillsDir, id, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"${ffBlock}\n---\n\nInstructions for ${id}.\n`,
  );
  const indexPath = join(skillsDir, "SKILLS.md");
  const existing = existsSync(indexPath)
    ? readFileSync(indexPath, "utf-8")
    : "";
  writeFileSync(indexPath, existing + `- ${id}\n`);
}

// ---------------------------------------------------------------------------
// System prompt — assistant feature flag filtering
// ---------------------------------------------------------------------------

describe("buildSystemPrompt assistant feature flag filtering", () => {
  test("flag OFF skill does not appear in skills catalog", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      DECLARED_FLAG_ID,
    );
    createSkillOnDisk(
      "browser",
      "Browser",
      "Web browsing automation",
      "browser",
    );

    currentConfig = {
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.browser.enabled": true,
      },
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    // browser is explicitly enabled, declared flagged skill is explicitly off
    expect(result).toContain("**browser**");
    expect(result).not.toContain(`**${DECLARED_SKILL_ID}**`);
  });

  test("declared skills hidden when no flag overrides set (registry defaults to false)", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      DECLARED_FLAG_ID,
    );
    createSkillOnDisk(
      "email-channel",
      "Email Channel",
      "Email channel setup",
      "email-channel",
    );

    currentConfig = {
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    // Both skills declare feature flags with registry defaultEnabled: false
    expect(result).not.toContain(`**${DECLARED_SKILL_ID}**`);
    expect(result).not.toContain("**email-channel**");
  });

  test("flagged-off skills hidden when all flags are OFF", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      DECLARED_FLAG_ID,
    );
    createSkillOnDisk(
      "email-channel",
      "Email Channel",
      "Email channel setup",
      "email-channel",
    );

    currentConfig = {
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.email-channel.enabled": false,
      },
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    expect(result).not.toContain(`**${DECLARED_SKILL_ID}**`);
    expect(result).not.toContain("**email-channel**");
  });

  test("assistantFeatureFlagValues overrides control visibility", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      DECLARED_FLAG_ID,
    );

    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    expect(result).toContain(`**${DECLARED_SKILL_ID}**`);
  });

  test("persisted overrides for undeclared flags are respected", () => {
    createSkillOnDisk(
      "browser",
      "Browser",
      "Web browsing automation",
      "browser",
    );

    currentConfig = {
      assistantFeatureFlagValues: { "feature_flags.browser.enabled": false },
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    // browser declares featureFlag: "browser" and the user
    // explicitly disabled it — that override must be honored.
    expect(result).not.toContain("**browser**");
  });

  test("declared flags with no persisted override use registry default", () => {
    createSkillOnDisk(
      "browser",
      "Browser",
      "Web browsing automation",
      "browser",
    );

    currentConfig = {
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    // browser is declared in the registry with defaultEnabled: true
    expect(result).toContain("**browser**");
  });

  test("skill without featureFlag is never flag-gated", () => {
    createSkillOnDisk("my-skill", "My Skill", "A skill without feature flag");

    currentConfig = {
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
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    };

    const result = buildSystemPrompt();

    // Skills without featureFlag declared are never gated — always pass through
    expect(result).toContain("**my-skill**");
  });
});

// ---------------------------------------------------------------------------
// Resolver unit tests (within integration context)
// ---------------------------------------------------------------------------

describe("isAssistantFeatureFlagEnabled", () => {
  test("reads from assistantFeatureFlagValues", () => {
    const config = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    } as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(true);
  });

  test("explicit false override in assistantFeatureFlagValues", () => {
    const config = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    } as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("missing persisted value falls back to defaults registry defaultEnabled", () => {
    // No explicit config at all — should fall back to defaults registry
    // which has defaultEnabled: false for contacts
    const config = {} as any;

    expect(isAssistantFeatureFlagEnabled(DECLARED_FLAG_KEY, config)).toBe(
      false,
    );
  });

  test("unknown flag defaults to true when no persisted override", () => {
    const config = {} as any;

    expect(
      isAssistantFeatureFlagEnabled(
        "feature_flags.unknown-skill.enabled",
        config,
      ),
    ).toBe(true);
  });

  test("undeclared flag respects persisted canonical override", () => {
    const config = {
      assistantFeatureFlagValues: { "feature_flags.browser.enabled": false },
    } as any;

    expect(
      isAssistantFeatureFlagEnabled("feature_flags.browser.enabled", config),
    ).toBe(false);
  });
});

describe("isAssistantFeatureFlagEnabled with skillFlagKey", () => {
  test("resolves skill flag via canonical path", () => {
    const config = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    } as any;

    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(false);
  });

  test("disabled when no override set (registry default is false)", () => {
    const config = {} as any;

    expect(
      isAssistantFeatureFlagEnabled(
        skillFlagKey({ featureFlag: DECLARED_FLAG_ID })!,
        config,
      ),
    ).toBe(false);
  });
});
