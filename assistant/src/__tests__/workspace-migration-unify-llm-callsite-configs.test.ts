import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { unifyLlmCallSiteConfigsMigration } from "../workspace/migrations/038-unify-llm-callsite-configs.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-038-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("038-unify-llm-callsite-configs migration", () => {
  test("has correct migration id and description", () => {
    expect(unifyLlmCallSiteConfigsMigration.id).toBe(
      "038-unify-llm-callsite-configs",
    );
    expect(unifyLlmCallSiteConfigsMigration.description).toBe(
      "Consolidate scattered LLM config keys into unified llm.{default,profiles,callSites} structure",
    );
  });

  // ─── No-op cases ────────────────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    unifyLlmCallSiteConfigsMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON in config file", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    unifyLlmCallSiteConfigsMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles array-shaped config", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));
    unifyLlmCallSiteConfigsMigration.run(workspaceDir);
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("idempotent: early-returns when llm.default is already present", () => {
    const original = {
      llm: {
        default: {
          provider: "openai",
          model: "gpt-5.4",
          maxTokens: 32000,
          effort: "high",
          speed: "fast",
          temperature: null,
        },
      },
      services: {
        inference: { provider: "anthropic", model: "claude-opus-4-6" },
      },
      maxTokens: 64000,
    };
    writeConfig(original);

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });

  // ─── Defaults from schema (no scattered keys) ──────────────────────────

  test("workspace with no scattered keys produces minimal llm.default from schema defaults", () => {
    writeConfig({});

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.llm).toEqual({
      default: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        maxTokens: 64000,
        effort: "max",
        speed: "standard",
        temperature: null,
      },
    });
  });

  // ─── Default block reads from scattered sources ────────────────────────

  test("llm.default reads provider/model from services.inference when present", () => {
    writeConfig({
      services: {
        inference: { provider: "openai", model: "gpt-5.4" },
      },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { default: Record<string, unknown> };
    expect(llm.default.provider).toBe("openai");
    expect(llm.default.model).toBe("gpt-5.4");
  });

  test("llm.default falls back to top-level provider/model when services.inference absent", () => {
    writeConfig({
      provider: "openai",
      model: "gpt-5.4",
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { default: Record<string, unknown> };
    expect(llm.default.provider).toBe("openai");
    expect(llm.default.model).toBe("gpt-5.4");
  });

  test("llm.default reads top-level maxTokens/effort/speed/thinking/contextWindow", () => {
    writeConfig({
      maxTokens: 16000,
      effort: "low",
      speed: "fast",
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { enabled: true, maxInputTokens: 100000 },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { default: Record<string, unknown> };
    expect(llm.default.maxTokens).toBe(16000);
    expect(llm.default.effort).toBe("low");
    expect(llm.default.speed).toBe("fast");
    expect(llm.default.thinking).toEqual({
      enabled: false,
      streamThinking: false,
    });
    expect(llm.default.contextWindow).toEqual({
      enabled: true,
      maxInputTokens: 100000,
    });
  });

  test("llm.default.temperature is null (no current source)", () => {
    writeConfig({});

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { default: Record<string, unknown> };
    expect(llm.default.temperature).toBeNull();
  });

  // ─── Full mapping (every scattered key) ────────────────────────────────

  test("workspace with every scattered key set maps all entries correctly", () => {
    writeConfig({
      services: {
        inference: { provider: "openai", model: "gpt-5.4" },
      },
      maxTokens: 32000,
      effort: "high",
      speed: "standard",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: { maxInputTokens: 150000 },
      heartbeat: { speed: "fast" },
      filing: { speed: "fast" },
      analysis: { modelOverride: "anthropic/claude-opus-4-6" },
      memory: { summarization: { modelIntent: "latency-optimized" } },
      workspaceGit: {
        commitMessageLLM: { maxTokens: 200, temperature: 0.4 },
      },
      ui: { greetingModelIntent: "quality-optimized" },
      notifications: { decisionModelIntent: "vision-optimized" },
      calls: { model: "gpt-5.4-nano" },
      pricingOverrides: [
        {
          provider: "openai",
          modelPattern: "gpt-5.4",
          inputPer1M: 1,
          outputPer1M: 2,
        },
      ],
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      default: Record<string, unknown>;
      callSites: Record<string, Record<string, unknown>>;
      pricingOverrides: unknown;
    };

    expect(llm.default).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      maxTokens: 32000,
      effort: "high",
      speed: "standard",
      temperature: null,
      thinking: { enabled: true, streamThinking: true },
      contextWindow: { maxInputTokens: 150000 },
    });

    // heartbeat/filing speeds differ from default ("standard") so they appear
    expect(llm.callSites.heartbeatAgent).toEqual({ speed: "fast" });
    expect(llm.callSites.filingAgent).toEqual({ speed: "fast" });
    // analysis.modelOverride parses as provider/model pair
    expect(llm.callSites.analyzeConversation).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    // memory.summarization.modelIntent ("latency-optimized") for openai → gpt-5.4-nano
    expect(llm.callSites.conversationSummarization).toEqual({
      model: "gpt-5.4-nano",
    });
    // commit message overrides forward
    expect(llm.callSites.commitMessage).toEqual({
      maxTokens: 200,
      temperature: 0.4,
    });
    // ui.greetingModelIntent ("quality-optimized") for openai → gpt-5.4
    expect(llm.callSites.emptyStateGreeting).toEqual({ model: "gpt-5.4" });
    // notifications.decisionModelIntent ("vision-optimized") for openai → gpt-5.4
    // The same intent drives BOTH notificationDecision and
    // preferenceExtraction (both legacy readers consult the same key).
    expect(llm.callSites.notificationDecision).toEqual({ model: "gpt-5.4" });
    expect(llm.callSites.preferenceExtraction).toEqual({ model: "gpt-5.4" });
    // calls.model copied verbatim
    expect(llm.callSites.callAgent).toEqual({ model: "gpt-5.4-nano" });

    expect(llm.pricingOverrides).toEqual([
      {
        provider: "openai",
        modelPattern: "gpt-5.4",
        inputPer1M: 1,
        outputPer1M: 2,
      },
    ]);
  });

  // ─── Partial mapping (only some scattered keys) ────────────────────────

  test("only heartbeat.speed set produces only heartbeatAgent call site", () => {
    writeConfig({
      heartbeat: { speed: "fast" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.heartbeatAgent).toEqual({ speed: "fast" });
    expect(llm.callSites?.filingAgent).toBeUndefined();
    expect(llm.callSites?.analyzeConversation).toBeUndefined();
  });

  test("heartbeat.speed equal to default speed is dropped (no override needed)", () => {
    writeConfig({
      speed: "fast",
      heartbeat: { speed: "fast" }, // matches default → no override
      filing: { speed: "standard" }, // differs → override
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      default: Record<string, unknown>;
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.default.speed).toBe("fast");
    expect(llm.callSites?.heartbeatAgent).toBeUndefined();
    expect(llm.callSites?.filingAgent).toEqual({ speed: "standard" });
  });

  test("only analysis.modelOverride set produces only analyzeConversation call site", () => {
    writeConfig({
      analysis: { modelOverride: "anthropic/claude-opus-4-7" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.analyzeConversation).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(llm.callSites?.heartbeatAgent).toBeUndefined();
  });

  test("analysis.modelOverride parsing handles 'anthropic/claude-opus-4-6'", () => {
    writeConfig({
      analysis: { modelOverride: "anthropic/claude-opus-4-6" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.analyzeConversation).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  test("analysis.modelOverride without slash treats whole value as model", () => {
    writeConfig({
      analysis: { modelOverride: "claude-opus-4-6" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.analyzeConversation).toEqual({
      model: "claude-opus-4-6",
    });
  });

  test("analysis.modelOverride with multi-segment model preserves rest of path", () => {
    // Some providers (e.g. fireworks, openrouter) use multi-segment model IDs
    writeConfig({
      analysis: {
        modelOverride: "fireworks/accounts/fireworks/models/kimi-k2p5",
      },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.analyzeConversation).toEqual({
      provider: "fireworks",
      model: "accounts/fireworks/models/kimi-k2p5",
    });
  });

  test("analysis.modelIntent (no override) resolves intent against active provider", () => {
    writeConfig({
      services: {
        inference: { provider: "anthropic", model: "claude-opus-4-6" },
      },
      analysis: { modelIntent: "latency-optimized" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    // anthropic + latency-optimized → claude-haiku-4-5-20251001
    expect(llm.callSites?.analyzeConversation).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
  });

  test("commitMessage only includes set fields", () => {
    writeConfig({
      workspaceGit: {
        commitMessageLLM: { maxTokens: 150 },
      },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.commitMessage).toEqual({ maxTokens: 150 });
  });

  test("calls.model only set produces only callAgent override", () => {
    writeConfig({
      calls: { model: "gpt-5.4-nano" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites?.callAgent).toEqual({ model: "gpt-5.4-nano" });
  });

  // ─── Regression: notifications.decisionModelIntent → both call sites ──

  test("notifications.decisionModelIntent seeds BOTH notificationDecision and preferenceExtraction", () => {
    // The legacy `notifications.decisionModelIntent` is the single source of
    // truth for two readers: `notifications/decision-engine.ts` (notification
    // classification) and `notifications/preference-extractor.ts` (preference
    // extraction). The migration must seed both call sites from the same
    // intent so neither path silently regresses to the schema default.
    writeConfig({
      services: {
        inference: { provider: "anthropic", model: "claude-opus-4-6" },
      },
      notifications: { decisionModelIntent: "latency-optimized" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites?: Record<string, Record<string, unknown>>;
    };
    // anthropic + latency-optimized → claude-haiku-4-5-20251001
    expect(llm.callSites?.notificationDecision).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
    expect(llm.callSites?.preferenceExtraction).toEqual({
      model: "claude-haiku-4-5-20251001",
    });
  });

  // ─── Regression: pre-existing llm subtree is preserved ────────────────

  test("pre-existing llm.callSites and llm.profiles survive migration", () => {
    // A workspace can legitimately have `llm.callSites` and/or
    // `llm.profiles` set without `llm.default` (defaults are schema-injected
    // at parse time). The migration's idempotency check looks at
    // `llm.default`, so it will run against this workspace — and must
    // preserve the user-defined entries instead of clobbering the entire
    // `llm` block. Migration-derived call sites should still appear, but
    // pre-existing call-site keys not produced by the migration must be
    // retained, and `llm.profiles` must pass through verbatim.
    writeConfig({
      llm: {
        callSites: {
          memoryRetrieval: { provider: "openai", model: "gpt-4o-mini" },
        },
        profiles: { fast: { speed: "fast" } },
      },
      services: {
        inference: { provider: "anthropic", model: "claude-opus-4-6" },
      },
      analysis: { modelOverride: "anthropic/claude-opus-4-7" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      default: Record<string, unknown>;
      callSites: Record<string, Record<string, unknown>>;
      profiles: Record<string, unknown>;
    };

    // Default block was synthesized from legacy keys.
    expect(llm.default.provider).toBe("anthropic");
    expect(llm.default.model).toBe("claude-opus-4-6");

    // Pre-existing call-site survives.
    expect(llm.callSites.memoryRetrieval).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    // Migration-derived call-site is added.
    expect(llm.callSites.analyzeConversation).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });

    // Pre-existing profiles survive verbatim.
    expect(llm.profiles).toEqual({ fast: { speed: "fast" } });
  });

  test("pre-existing llm.callSites entry with same key is overwritten by migration", () => {
    // When a pre-existing call-site key collides with a migration-derived
    // one, the migration value wins (legacy scattered config is the source
    // of truth being unified). This documents the merge precedence.
    writeConfig({
      llm: {
        callSites: {
          // Stale value the user wrote directly; will be overwritten because
          // the migration also produces `analyzeConversation` from
          // `analysis.modelOverride`.
          analyzeConversation: { model: "stale-model" },
        },
      },
      analysis: { modelOverride: "anthropic/claude-opus-4-6" },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as {
      callSites: Record<string, Record<string, unknown>>;
    };
    expect(llm.callSites.analyzeConversation).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
  });

  test("pre-existing llm.pricingOverrides is preserved when legacy top-level is absent", () => {
    // If the user has only `llm.pricingOverrides` (no top-level
    // `pricingOverrides`), the migration must not drop them.
    const overrides = [
      {
        provider: "anthropic",
        modelPattern: "claude-*",
        inputPer1M: 5,
        outputPer1M: 25,
      },
    ];
    writeConfig({
      llm: { pricingOverrides: overrides },
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { pricingOverrides?: unknown };
    expect(llm.pricingOverrides).toEqual(overrides);
  });

  test("legacy top-level pricingOverrides wins over pre-existing llm.pricingOverrides", () => {
    // When both sources exist, the legacy top-level wins (it's the
    // canonical source the migration is unifying from). This documents the
    // precedence rule.
    const legacy = [
      {
        provider: "openai",
        modelPattern: "gpt-5.4",
        inputPer1M: 1,
        outputPer1M: 2,
      },
    ];
    const preExisting = [
      {
        provider: "anthropic",
        modelPattern: "claude-*",
        inputPer1M: 99,
        outputPer1M: 99,
      },
    ];
    writeConfig({
      llm: { pricingOverrides: preExisting },
      pricingOverrides: legacy,
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { pricingOverrides?: unknown };
    expect(llm.pricingOverrides).toEqual(legacy);
  });

  // ─── Old keys preserved ────────────────────────────────────────────────

  test("old keys are still present after migration (not deleted)", () => {
    const original = {
      services: { inference: { provider: "openai", model: "gpt-5.4" } },
      maxTokens: 32000,
      effort: "high",
      speed: "fast",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: { maxInputTokens: 150000 },
      heartbeat: { speed: "standard" },
      filing: { speed: "standard" },
      analysis: { modelOverride: "anthropic/claude-opus-4-6" },
      memory: { summarization: { modelIntent: "quality-optimized" } },
      workspaceGit: {
        commitMessageLLM: { maxTokens: 120, temperature: 0.2 },
      },
      ui: { greetingModelIntent: "latency-optimized" },
      notifications: { decisionModelIntent: "latency-optimized" },
      calls: { model: "gpt-5.4-nano" },
      pricingOverrides: [
        {
          provider: "openai",
          modelPattern: "gpt-5.4",
          inputPer1M: 1,
          outputPer1M: 2,
        },
      ],
    };
    writeConfig(original);

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const config = readConfig();
    // Every original key must still be present
    for (const key of Object.keys(original)) {
      expect(config[key]).toEqual(
        original[key as keyof typeof original] as unknown,
      );
    }
    expect(config.llm).toBeDefined();
  });

  // ─── Idempotency ───────────────────────────────────────────────────────

  test("idempotency: running twice produces identical output", () => {
    writeConfig({
      services: { inference: { provider: "openai", model: "gpt-5.4" } },
      maxTokens: 32000,
      heartbeat: { speed: "fast" },
      filing: { speed: "fast" },
      analysis: { modelOverride: "anthropic/claude-opus-4-6" },
      ui: { greetingModelIntent: "quality-optimized" },
      pricingOverrides: [
        {
          provider: "openai",
          modelPattern: "gpt-5.4",
          inputPer1M: 1,
          outputPer1M: 2,
        },
      ],
    });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);
    const afterFirst = readConfig();

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  // ─── pricingOverrides handling ─────────────────────────────────────────

  test("pricingOverrides copied to llm.pricingOverrides", () => {
    const overrides = [
      {
        provider: "anthropic",
        modelPattern: "claude-*",
        inputPer1M: 3,
        outputPer1M: 15,
      },
    ];
    writeConfig({ pricingOverrides: overrides });

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as { pricingOverrides?: unknown };
    expect(llm.pricingOverrides).toEqual(overrides);
  });

  test("missing pricingOverrides results in no llm.pricingOverrides field", () => {
    writeConfig({});

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);

    const llm = readConfig().llm as Record<string, unknown>;
    expect("pricingOverrides" in llm).toBe(false);
  });

  // ─── down() rollback ───────────────────────────────────────────────────

  test("down() reverses a migrated config to original shape", () => {
    const original = {
      services: { inference: { provider: "openai", model: "gpt-5.4" } },
      maxTokens: 32000,
      effort: "high",
      speed: "standard",
      thinking: { enabled: true, streamThinking: true },
      contextWindow: { maxInputTokens: 150000 },
      heartbeat: { speed: "fast" },
      filing: { speed: "fast" },
      analysis: { modelOverride: "anthropic/claude-opus-4-6" },
      workspaceGit: {
        commitMessageLLM: { maxTokens: 200, temperature: 0.4 },
      },
      calls: { model: "gpt-5.4-nano" },
      pricingOverrides: [
        {
          provider: "openai",
          modelPattern: "gpt-5.4",
          inputPer1M: 1,
          outputPer1M: 2,
        },
      ],
    };
    writeConfig(original);

    unifyLlmCallSiteConfigsMigration.run(workspaceDir);
    // Sanity: llm block exists after run()
    expect((readConfig() as { llm?: unknown }).llm).toBeDefined();

    unifyLlmCallSiteConfigsMigration.down(workspaceDir);

    const config = readConfig();
    // The llm block must be removed.
    expect("llm" in config).toBe(false);
    // Every original scalar/object key that had a reverse mapping must be
    // restored to its original value.
    expect(config.services).toEqual(original.services);
    expect(config.maxTokens).toBe(original.maxTokens);
    expect(config.effort).toBe(original.effort);
    expect(config.speed).toBe(original.speed);
    expect(config.thinking).toEqual(original.thinking);
    expect(config.contextWindow).toEqual(original.contextWindow);
    expect(config.heartbeat).toEqual(original.heartbeat);
    expect(config.filing).toEqual(original.filing);
    expect(config.analysis).toEqual(original.analysis);
    expect(config.workspaceGit).toEqual(original.workspaceGit);
    expect(config.calls).toEqual(original.calls);
    expect(config.pricingOverrides).toEqual(original.pricingOverrides);
  });

  test("down() is a no-op when llm block is absent", () => {
    const original = {
      maxTokens: 32000,
      services: {
        inference: { provider: "anthropic", model: "claude-opus-4-6" },
      },
    };
    writeConfig(original);

    unifyLlmCallSiteConfigsMigration.down(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(original);
  });
});
