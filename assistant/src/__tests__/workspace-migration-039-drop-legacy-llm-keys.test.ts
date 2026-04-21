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

import { dropLegacyLlmKeysMigration } from "../workspace/migrations/039-drop-legacy-llm-keys.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-039-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("039-drop-legacy-llm-keys migration", () => {
  test("has correct migration id and description", () => {
    expect(dropLegacyLlmKeysMigration.id).toBe("039-drop-legacy-llm-keys");
    expect(dropLegacyLlmKeysMigration.description).toBe(
      "Strip deprecated scattered LLM-related keys from config.json (post-PR-19 cleanup)",
    );
  });

  // ─── No-op cases ────────────────────────────────────────────────────────

  test("no-op when config.json does not exist", () => {
    dropLegacyLlmKeysMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON in config file", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");
    dropLegacyLlmKeysMigration.run(workspaceDir);
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles array-shaped config", () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));
    dropLegacyLlmKeysMigration.run(workspaceDir);
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("no-op when config has none of the targeted legacy keys", () => {
    const original = {
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          maxTokens: 64000,
          effort: "max",
          speed: "standard",
          temperature: null,
        },
      },
      services: { inference: { mode: "your-own" } },
      otherSetting: true,
    };
    writeConfig(original);

    dropLegacyLlmKeysMigration.run(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  // ─── Full strip — every legacy key present ─────────────────────────────

  test("strips every targeted legacy key when all are present", () => {
    writeConfig({
      // Top-level scattered keys
      maxTokens: 16000,
      effort: "low",
      speed: "fast",
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { enabled: true, maxInputTokens: 100000 },
      pricingOverrides: [
        {
          provider: "anthropic",
          modelPattern: "*",
          inputPer1M: 1,
          outputPer1M: 5,
        },
      ],
      // services.inference.{provider, model}
      services: {
        inference: {
          mode: "your-own",
          provider: "openai",
          model: "gpt-5.4",
        },
      },
      // heartbeat.speed / filing.speed
      heartbeat: { enabled: true, intervalMs: 60000, speed: "fast" },
      filing: { enabled: true, intervalMs: 30000, speed: "fast" },
      // analysis
      analysis: {
        enabled: true,
        modelIntent: "quality-optimized",
        modelOverride: "claude-opus-4-7",
      },
      // memory.summarization.modelIntent
      memory: { summarization: { modelIntent: "latency-optimized" } },
      // notifications.decisionModelIntent
      notifications: { decisionModelIntent: "latency-optimized" },
      // ui.greetingModelIntent
      ui: { greetingModelIntent: "quality-optimized" },
      // calls.model
      calls: { enabled: true, model: "gpt-5.4-nano" },
      // workspaceGit.commitMessageLLM.*
      workspaceGit: {
        commitMessageLLM: {
          maxTokens: 1024,
          temperature: 0.2,
          useConfiguredProvider: true,
          providerFastModelOverrides: { anthropic: "claude-haiku-3-5" },
        },
      },
      // Unrelated key — must survive
      otherSetting: "preserved",
    });

    dropLegacyLlmKeysMigration.run(workspaceDir);

    const config = readConfig();

    // Top-level
    expect(config.maxTokens).toBeUndefined();
    expect(config.effort).toBeUndefined();
    expect(config.speed).toBeUndefined();
    expect(config.thinking).toBeUndefined();
    expect(config.contextWindow).toBeUndefined();
    expect(config.pricingOverrides).toBeUndefined();

    // services.inference: provider/model stripped, mode preserved
    const services = config.services as { inference: Record<string, unknown> };
    expect(services.inference.provider).toBeUndefined();
    expect(services.inference.model).toBeUndefined();
    expect(services.inference.mode).toBe("your-own");

    // heartbeat / filing
    const heartbeat = config.heartbeat as Record<string, unknown>;
    expect(heartbeat.speed).toBeUndefined();
    expect(heartbeat.enabled).toBe(true);
    expect(heartbeat.intervalMs).toBe(60000);
    const filing = config.filing as Record<string, unknown>;
    expect(filing.speed).toBeUndefined();
    expect(filing.enabled).toBe(true);
    expect(filing.intervalMs).toBe(30000);

    // analysis
    const analysis = config.analysis as Record<string, unknown>;
    expect(analysis.modelIntent).toBeUndefined();
    expect(analysis.modelOverride).toBeUndefined();
    expect(analysis.enabled).toBe(true);

    // memory.summarization.modelIntent
    const memory = config.memory as { summarization: Record<string, unknown> };
    expect(memory.summarization.modelIntent).toBeUndefined();

    // notifications.decisionModelIntent
    const notifications = config.notifications as Record<string, unknown>;
    expect(notifications.decisionModelIntent).toBeUndefined();

    // ui.greetingModelIntent
    const ui = config.ui as Record<string, unknown>;
    expect(ui.greetingModelIntent).toBeUndefined();

    // calls.model
    const calls = config.calls as Record<string, unknown>;
    expect(calls.model).toBeUndefined();
    expect(calls.enabled).toBe(true);

    // workspaceGit.commitMessageLLM
    const workspaceGit = config.workspaceGit as {
      commitMessageLLM: Record<string, unknown>;
    };
    expect(workspaceGit.commitMessageLLM.maxTokens).toBeUndefined();
    expect(workspaceGit.commitMessageLLM.temperature).toBeUndefined();
    expect(workspaceGit.commitMessageLLM.useConfiguredProvider).toBeUndefined();
    expect(
      workspaceGit.commitMessageLLM.providerFastModelOverrides,
    ).toBeUndefined();

    // Unrelated key untouched
    expect(config.otherSetting).toBe("preserved");
  });

  // ─── Partial strip ─────────────────────────────────────────────────────

  test("strips only the legacy keys actually present", () => {
    writeConfig({
      // Only a few legacy keys present
      speed: "fast",
      services: { inference: { mode: "managed", provider: "anthropic" } },
      notifications: { decisionModelIntent: "latency-optimized" },
      // Unrelated keys
      maxStepsPerSession: 50,
    });

    dropLegacyLlmKeysMigration.run(workspaceDir);

    const config = readConfig();
    expect(config.speed).toBeUndefined();
    const services = config.services as { inference: Record<string, unknown> };
    expect(services.inference.provider).toBeUndefined();
    expect(services.inference.mode).toBe("managed");
    expect(
      (config.notifications as Record<string, unknown>).decisionModelIntent,
    ).toBeUndefined();
    expect(config.maxStepsPerSession).toBe(50);
  });

  // ─── services.inference.mode preservation ──────────────────────────────

  test("preserves services.inference.mode while stripping provider/model", () => {
    writeConfig({
      services: {
        inference: { mode: "your-own", provider: "openai", model: "gpt-5.4" },
      },
    });

    dropLegacyLlmKeysMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as { inference: Record<string, unknown> };
    expect(services.inference.mode).toBe("your-own");
    expect(services.inference.provider).toBeUndefined();
    expect(services.inference.model).toBeUndefined();
  });

  // ─── Idempotency ───────────────────────────────────────────────────────

  test("idempotency: re-running the migration yields no further mutation", () => {
    writeConfig({
      speed: "fast",
      services: {
        inference: { mode: "your-own", provider: "openai", model: "gpt-5.4" },
      },
      heartbeat: { enabled: true, speed: "fast" },
      calls: { enabled: true, model: "gpt-5.4-nano" },
    });

    dropLegacyLlmKeysMigration.run(workspaceDir);
    const afterFirst = readConfig();

    dropLegacyLlmKeysMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("idempotency: writes nothing on a clean config (no targeted keys)", () => {
    const clean = {
      llm: { default: { provider: "anthropic", model: "claude-opus-4-6" } },
      services: { inference: { mode: "your-own" } },
    };
    writeConfig(clean);

    const beforeStat = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );

    dropLegacyLlmKeysMigration.run(workspaceDir);

    const afterStat = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );

    expect(afterStat).toEqual(beforeStat);
  });

  // ─── Defensive shape handling ──────────────────────────────────────────

  test("ignores non-object values at sub-paths (e.g. numbers, arrays)", () => {
    // Attacker-style or otherwise corrupt config — the migration should not
    // throw on unexpected shapes. Defensive readObject() helper coerces
    // non-objects to null and the migration skips them.
    writeConfig({
      services: 42,
      heartbeat: ["a", "b"],
      calls: null,
      workspaceGit: { commitMessageLLM: "not-an-object" },
      // A real legacy key alongside garbage
      speed: "fast",
    });

    dropLegacyLlmKeysMigration.run(workspaceDir);

    const config = readConfig();
    // The valid top-level legacy key still gets stripped
    expect(config.speed).toBeUndefined();
    // Garbage shapes preserved as-is
    expect(config.services).toBe(42);
    expect(config.heartbeat).toEqual(["a", "b"]);
    expect(config.calls).toBeNull();
    expect(config.workspaceGit).toEqual({ commitMessageLLM: "not-an-object" });
  });
});
