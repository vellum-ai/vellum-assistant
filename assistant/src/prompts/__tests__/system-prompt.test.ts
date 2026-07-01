/**
 * Smoke tests for buildSystemPrompt — covers tool-routing-guidance
 * exclusions and other call-shape invariants. Background-conversation
 * guidance is no longer rendered into the system prompt; see
 * `__tests__/injector-background-turn.test.ts` for the per-turn
 * user-message injection that replaced it.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

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

const { buildSystemPrompt, maybeReseedBootstrap } =
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

describe("buildSystemPrompt — persona override", () => {
  const DEFAULT_SENTINEL = "Sentinel: default persona body.";
  const ALICE_SENTINEL = "Sentinel: alice persona body.";
  const TELEGRAM_SENTINEL = "Sentinel: telegram channel persona body.";

  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "users"), { recursive: true });
    mkdirSync(join(TEST_DIR, "channels"), { recursive: true });
    writeFileSync(join(TEST_DIR, "users", "default.md"), DEFAULT_SENTINEL);
    writeFileSync(join(TEST_DIR, "users", "alice.md"), ALICE_SENTINEL);
    writeFileSync(join(TEST_DIR, "channels", "telegram.md"), TELEGRAM_SENTINEL);
  });

  test("personaOverride renders the given user + channel persona sections", () => {
    const result = buildSystemPrompt({
      personaOverride: { userSlug: "alice", channelSlug: "telegram" },
    });

    expect(result).toContain(ALICE_SENTINEL);
    expect(result).toContain(TELEGRAM_SENTINEL);
    expect(result).not.toContain(DEFAULT_SENTINEL);
  });

  test("no override → trust-context-derived resolution (default persona, vellum channel)", () => {
    // No trust context and no resolvable guardian contact in this test env,
    // so the user persona falls back to users/default.md and the channel
    // section resolves channels/vellum.md (absent → omitted).
    const result = buildSystemPrompt({});

    expect(result).toContain(DEFAULT_SENTINEL);
    expect(result).not.toContain(ALICE_SENTINEL);
    expect(result).not.toContain(TELEGRAM_SENTINEL);
  });

  test("partial override: userSlug alone leaves channel resolution untouched", () => {
    const result = buildSystemPrompt({
      personaOverride: { userSlug: "alice" },
    });

    expect(result).toContain(ALICE_SENTINEL);
    expect(result).not.toContain(TELEGRAM_SENTINEL);
  });

  test("override userSlug with no matching file falls back to users/default.md", () => {
    const result = buildSystemPrompt({
      personaOverride: { userSlug: "missing-user" },
    });

    expect(result).toContain(DEFAULT_SENTINEL);
  });
});

describe("buildSystemPrompt — default persona trust-class guardrail", () => {
  // Marker strings from the bundled users/default.md template.
  const GUARDRAIL = "Protect your guardian's privacy";
  const TRUSTED_GREETING = "You're talking with a trusted contact";
  const STRANGER_GREETING = "You're talking with someone you don't recognize";

  const templatesDir = join(import.meta.dirname!, "..", "templates");
  let priorAuthEnv: string | undefined;

  beforeEach(() => {
    // Captured so the DISABLE_HTTP_AUTH regression test below can restore it.
    priorAuthEnv = process.env.DISABLE_HTTP_AUTH;

    mkdirSync(join(TEST_DIR, "users"), { recursive: true });
    // Render the real shipped template, not a sentinel.
    copyFileSync(
      join(templatesDir, "users", "default.md"),
      join(TEST_DIR, "users", "default.md"),
    );
  });

  afterEach(() => {
    if (priorAuthEnv === undefined) delete process.env.DISABLE_HTTP_AUTH;
    else process.env.DISABLE_HTTP_AUTH = priorAuthEnv;
  });

  test("stranger (unknown) sees the guardrail and the stranger greeting", () => {
    const result = buildSystemPrompt({
      trustContext: { sourceChannel: "slack", trustClass: "unknown" },
    });

    expect(result).toContain(GUARDRAIL);
    expect(result).toContain(STRANGER_GREETING);
    expect(result).not.toContain(TRUSTED_GREETING);
  });

  test("trusted contact sees the guardrail and the trusted greeting", () => {
    const result = buildSystemPrompt({
      trustContext: { sourceChannel: "slack", trustClass: "trusted_contact" },
    });

    expect(result).toContain(GUARDRAIL);
    expect(result).toContain(TRUSTED_GREETING);
    expect(result).not.toContain(STRANGER_GREETING);
  });

  test("unverified contact is framed like a trusted contact", () => {
    const result = buildSystemPrompt({
      trustContext: {
        sourceChannel: "slack",
        trustClass: "unverified_contact",
      },
    });

    expect(result).toContain(GUARDRAIL);
    expect(result).toContain(TRUSTED_GREETING);
    expect(result).not.toContain(STRANGER_GREETING);
  });

  test("guardian trust class gates the whole default persona off", () => {
    // A guardian normally renders their own users/<slug>.md; if they ever fall
    // back to default.md, every section is gated off and nothing leaks.
    const result = buildSystemPrompt({
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
    });

    expect(result).not.toContain(GUARDRAIL);
    expect(result).not.toContain(TRUSTED_GREETING);
    expect(result).not.toContain(STRANGER_GREETING);
  });

  test("renders for a non-guardian even when HTTP auth is disabled", () => {
    // Platform-managed deployments run with DISABLE_HTTP_AUTH=true, under which
    // resolveTrustClass() collapses every actor to "guardian". The guardrail
    // must gate on the actor's real trust class instead, or it would silently
    // switch off for the non-guardian channel actors it exists to protect.
    process.env.DISABLE_HTTP_AUTH = "true";
    const result = buildSystemPrompt({
      trustContext: { sourceChannel: "slack", trustClass: "unknown" },
    });

    expect(result).toContain(GUARDRAIL);
    expect(result).toContain(STRANGER_GREETING);
  });

  test("never leaks literal mustache tags or comment lines", () => {
    for (const trustClass of [
      "unknown",
      "trusted_contact",
      "unverified_contact",
      "guardian",
    ] as const) {
      const result = buildSystemPrompt({
        trustContext: { sourceChannel: "slack", trustClass },
      });
      expect(result).not.toContain("{{");
      expect(result).not.toContain("}}");
      expect(result).not.toContain("Lines starting with");
    }
  });
});

describe("buildSystemPrompt — hasNoClient no longer affects the prompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  // No system-prompt section branches on hasNoClient, so neither the flag nor
  // the SystemPromptPersonaOverride.hasNoClient pin changes prompt output.
  // Guards against a future section re-coupling to the flag.
  test("output is identical regardless of the flag or its pin", () => {
    const base = buildSystemPrompt({ hasNoClient: false });
    expect(buildSystemPrompt({ hasNoClient: true })).toBe(base);
    expect(
      buildSystemPrompt({
        hasNoClient: true,
        personaOverride: { hasNoClient: false },
      }),
    ).toBe(base);
  });
});

describe("maybeReseedBootstrap — content-automation template", () => {
  const templatesDir = join(import.meta.dirname!, "..", "templates");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Seed the workspace with the generic BOOTSTRAP.md so the bootstrap
    // reseed detects it as an unmodified template and overwrites it.
    copyFileSync(
      join(templatesDir, "BOOTSTRAP.md"),
      join(TEST_DIR, "BOOTSTRAP.md"),
    );
  });

  function reseedAndRead(): string {
    maybeReseedBootstrap("BOOTSTRAP-CONTENT-AUTOMATION.md");
    return readFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "utf-8");
  }

  test("loads the geo-writing skill on first turn", () => {
    const content = reseedAndRead();
    expect(content).toContain("geo-writing");
  });

  test("uses skill-first onboarding approach", () => {
    const content = reseedAndRead();
    expect(content).toContain("Skill-First Onboarding");
    expect(content).toContain("The skill is the onboarding");
  });

  test("includes comment-driven edit loop", () => {
    const content = reseedAndRead();
    expect(content).toContain("comment-driven");
    expect(content).toContain("comment_resolve");
    expect(content).toContain("document_update");
  });

  test("references VOICE.md for voice capture", () => {
    const content = reseedAndRead();
    expect(content).toContain("VOICE.md");
  });
});

describe("maybeReseedBootstrap — activation rail template", () => {
  const templatesDir = join(import.meta.dirname!, "..", "templates");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    copyFileSync(
      join(templatesDir, "BOOTSTRAP.md"),
      join(TEST_DIR, "BOOTSTRAP.md"),
    );
  });

  test("replaces generic bootstrap with the activation rail template", () => {
    maybeReseedBootstrap("BOOTSTRAP-ACTIVATION-RAIL.md");
    const content = readFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "utf-8");

    expect(content).toContain("BOOTSTRAP — Activation Rail");
    expect(content).toContain("People don't read");
    expect(content).toContain("Speed wins");

    // Propose: anti-speculation boundary on what "unstated" means.
    expect(content).toContain("status word");
    expect(content).toContain("don't say it");

    // Propose: infer-first framing — recommendation bound to the click.
    expect(content).toContain("You didn't say this");
    expect(content).toContain("the recommendation IS the click");

    // Propose: a surviving extract-and-offer mechanic.
    expect(content).toContain("clickable component, strongest first");

    // Propose: the extract-shape vs infer-shape example block.
    expect(content).toContain("extract-shape");
    expect(content).toContain("infer-shape");

    // Port: prompt-writing guidance (JARVIS-1124).
    expect(content).toContain("portable context brief, not a self-summary");
    expect(content).toContain("load-bearing work in the next month");
    expect(content).toContain("what to help with first");
    expect(content).toContain("another tool or collaborator");
  });
});
