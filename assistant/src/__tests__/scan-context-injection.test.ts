/**
 * Tests for Google Connect Scan context injection in buildSystemPrompt.
 *
 * The scan instructions are injected when:
 *   1. The `google-connect-scan` feature flag is enabled
 *   2. BOOTSTRAP.md is present (first conversation)
 *
 * The `googleConnected` flag is NOT a gate — the template covers both
 * Variant A (already connected) and Variant B (connects mid-conversation).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

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

// Mutable flag overrides — tests flip these to control feature gate.
const _mockFlagOverrides: Record<string, boolean> = {};

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string, _config: unknown): boolean => {
    const explicit = _mockFlagOverrides[key];
    if (typeof explicit === "boolean") return explicit;
    return false; // default to disabled for test isolation
  },
  loadDefaultsRegistry: () => ({}),
  initFeatureFlagOverrides: () => Promise.resolve(),
  clearFeatureFlagOverridesCache: () => {},
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

const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

const SCAN_OPEN_TAG = "<google_connect_scan_instructions>";
const SCAN_CLOSE_TAG = "</google_connect_scan_instructions>";

function seedBootstrap(): void {
  writeFileSync(
    join(TEST_DIR, "BOOTSTRAP.md"),
    "# First run\n\nWelcome aboard.",
  );
}

describe("Google Connect Scan context injection", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Clean up files from prior tests.
    for (const name of ["BOOTSTRAP.md", "IDENTITY.md", "SOUL.md"]) {
      const p = join(TEST_DIR, name);
      if (existsSync(p)) rmSync(p, { force: true });
    }
    // Reset flag overrides between tests.
    for (const key of Object.keys(_mockFlagOverrides)) {
      delete _mockFlagOverrides[key];
    }
  });

  test("injected when flag is on + BOOTSTRAP exists + googleConnected: true", () => {
    _mockFlagOverrides["google-connect-scan"] = true;
    seedBootstrap();

    const result = buildSystemPrompt({
      onboardingContext: {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
      },
    });

    expect(result).toContain(SCAN_OPEN_TAG);
    expect(result).toContain(SCAN_CLOSE_TAG);
    expect(result).toContain("# Google Connect Scan");
  });

  test("NOT injected when flag is off", () => {
    _mockFlagOverrides["google-connect-scan"] = false;
    seedBootstrap();

    const result = buildSystemPrompt({
      onboardingContext: {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
      },
    });

    expect(result).not.toContain(SCAN_OPEN_TAG);
    expect(result).not.toContain("# Google Connect Scan");
  });

  test("injected when flag is on + BOOTSTRAP exists + googleConnected is false (Variant B)", () => {
    _mockFlagOverrides["google-connect-scan"] = true;
    seedBootstrap();

    const result = buildSystemPrompt({
      onboardingContext: {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: false,
      },
    });

    expect(result).toContain(SCAN_OPEN_TAG);
    expect(result).toContain(SCAN_CLOSE_TAG);
  });

  test("injected when flag is on + BOOTSTRAP exists + googleConnected is undefined (Variant B)", () => {
    _mockFlagOverrides["google-connect-scan"] = true;
    seedBootstrap();

    const result = buildSystemPrompt({
      onboardingContext: {
        tools: [],
        tasks: [],
        tone: "warm",
      },
    });

    expect(result).toContain(SCAN_OPEN_TAG);
    expect(result).toContain(SCAN_CLOSE_TAG);
  });

  test("NOT injected when flag is on + googleConnected but no BOOTSTRAP.md", () => {
    _mockFlagOverrides["google-connect-scan"] = true;
    // Do NOT seed BOOTSTRAP.md — simulate a non-first conversation.

    const result = buildSystemPrompt({
      onboardingContext: {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
      },
    });

    expect(result).not.toContain(SCAN_OPEN_TAG);
  });

  test("injected when flag is on + BOOTSTRAP exists + no onboarding context at all", () => {
    _mockFlagOverrides["google-connect-scan"] = true;
    seedBootstrap();

    const result = buildSystemPrompt({});

    expect(result).toContain(SCAN_OPEN_TAG);
    expect(result).toContain(SCAN_CLOSE_TAG);
  });

  test("scan block contains subagent dispatch instructions", () => {
    _mockFlagOverrides["google-connect-scan"] = true;
    seedBootstrap();

    const result = buildSystemPrompt({
      onboardingContext: {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
      },
    });

    // The template should include key scan phases.
    expect(result).toContain("Phase 1");
    expect(result).toContain("Phase 2");
    expect(result).toContain("subagent_spawn");
  });
});
