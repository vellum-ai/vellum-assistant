/**
 * Smoke tests for buildSystemPrompt — covers tool-routing-guidance
 * exclusions and other call-shape invariants. Background-conversation
 * guidance is no longer rendered into the system prompt; see
 * `__tests__/injector-background-turn.test.ts` for the per-turn
 * user-message injection that replaced it.
 */

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
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

const { buildSystemPrompt, maybeReseedBootstrapForCohort } =
  await import("../system-prompt.js");

describe("buildSystemPrompt — tool routing guidance", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  test("does not include ask_question routing guidance", () => {
    const result = buildSystemPrompt({});
    expect(result).not.toContain("## Clarifying questions");
    expect(result).not.toContain("ask_question");
  });
});

describe("maybeReseedBootstrapForCohort — content-automation template", () => {
  const templatesDir = join(import.meta.dirname!, "..", "templates");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Seed the workspace with the generic BOOTSTRAP.md so the cohort
    // reseed detects it as an unmodified template and overwrites it.
    copyFileSync(
      join(templatesDir, "BOOTSTRAP.md"),
      join(TEST_DIR, "BOOTSTRAP.md"),
    );
  });

  function reseedAndRead(): string {
    maybeReseedBootstrapForCohort("content-automation");
    return readFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "utf-8");
  }

  test("produces BOOTSTRAP.md containing credential_store prompt instructions", () => {
    const content = reseedAndRead();
    expect(content).toContain("credential_store");
    expect(content).toContain("action `prompt`");
  });

  test("contains all four path options", () => {
    const content = reseedAndRead();
    expect(content).toContain("I have a Sanity account");
    expect(content).toContain("I want to try Sanity");
    expect(content).toContain("website or blog");
    expect(content).toContain("somewhere else");
  });

  test("does NOT contain the old three-question pattern", () => {
    const content = reseedAndRead();
    // Old pattern batched three ask_question calls for separate fields
    expect(content).not.toContain("Batch three");
    expect(content).not.toContain("one question per field");
    expect(content).not.toContain("Project ID (options:");
    expect(content).not.toContain("Dataset name (options:");
    expect(content).not.toContain('API token (options: "I have one ready"');
  });

  test("references data/sanity-connection.json for project/dataset state", () => {
    const content = reseedAndRead();
    expect(content).toContain("data/sanity-connection.json");
  });

  test("references data/content-source.json for URL-import sidecar detection", () => {
    const content = reseedAndRead();
    expect(content).toContain("data/content-source.json");
  });

  test("instructs to skip triage when sanity-connection.json sidecar exists", () => {
    const content = reseedAndRead();
    // The preamble check must instruct skipping triage when the sidecar is present
    expect(content).toContain("data/sanity-connection.json");
    expect(content).toContain("Skip the triage question");
  });

  test("instructs to skip triage when content-source.json sidecar exists", () => {
    const content = reseedAndRead();
    expect(content).toContain("data/content-source.json");
    expect(content).toContain("Skip the triage question");
  });

  test("still contains four-option triage as fallback when no sidecars exist", () => {
    const content = reseedAndRead();
    // The "If neither exists" path must still present the four-option triage
    expect(content).toContain("I have a Sanity account");
    expect(content).toContain("I want to try Sanity");
    expect(content).toContain("website or blog");
    expect(content).toContain("somewhere else");
  });

  test("references assistant oauth request --provider sanity for authenticated API calls", () => {
    const content = reseedAndRead();
    expect(content).toContain("assistant oauth request --provider sanity");
  });
});
