/**
 * Tests for the Background Conversation gating in buildSystemPrompt.
 *
 * The Background Conversation guidance is gated on
 * `options.isBackgroundConversation === true`.  Interactive (default)
 * conversations must pay zero token cost — the section must be entirely
 * absent unless the flag is explicitly true.
 */

import { mkdirSync } from "node:fs";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const noopLogger: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
  },
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../../util/logger.js");
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const mockLoadedConfig: Record<string, unknown> = {};

mock.module("../../config/loader.js", () => ({
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
  loadConfig: () => mockLoadedConfig,
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

const { buildSystemPrompt, SYSTEM_PROMPT_CACHE_BOUNDARY } =
  await import("../system-prompt.js");

describe("buildSystemPrompt — Background Conversation gating", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  test("isBackgroundConversation: true — appends the Background Conversation section", () => {
    const result = buildSystemPrompt({ isBackgroundConversation: true });
    expect(result).toContain("## Background Conversation");
    expect(result).toContain("`notifications` skill");
    expect(result).toContain("assistant notifications send");
  });

  test("isBackgroundConversation: false — section is omitted", () => {
    const result = buildSystemPrompt({ isBackgroundConversation: false });
    expect(result).not.toContain("## Background Conversation");
  });

  test("options undefined — section is omitted (interactive default)", () => {
    const result = buildSystemPrompt(undefined);
    expect(result).not.toContain("## Background Conversation");
  });

  test("options provided without the flag — section is omitted", () => {
    const result = buildSystemPrompt({});
    expect(result).not.toContain("## Background Conversation");
  });

  test("section lives in the static (cached) block, not the dynamic suffix", () => {
    // The section is deterministic for a given conversationType, so it
    // belongs in staticParts to share the cache block with other
    // call-time-stable instructions.
    const result = buildSystemPrompt({ isBackgroundConversation: true });
    const boundaryIdx = result.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    expect(boundaryIdx).toBeGreaterThan(-1);
    const staticBlock = result.slice(0, boundaryIdx);
    const dynamicBlock = result.slice(
      boundaryIdx + SYSTEM_PROMPT_CACHE_BOUNDARY.length,
    );
    expect(staticBlock).toContain("## Background Conversation");
    expect(dynamicBlock).not.toContain("## Background Conversation");
  });
});
