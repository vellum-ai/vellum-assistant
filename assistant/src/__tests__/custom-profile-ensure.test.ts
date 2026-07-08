import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LLMConfigBase } from "../config/schemas/llm.js";
import { ensureCompleteCustomProfiles } from "../workspace/custom-profile-ensure.js";

let workspaceDir: string;

const distinctiveDefault = {
  provider: "anthropic",
  provider_connection: "anthropic-personal",
  model: "claude-opus-4-8",
  maxTokens: 12345,
  temperature: 0.7,
  logitBias: "suppress-cjk",
};

function writeConfig(config: unknown): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

function readProfiles(): Record<string, Record<string, unknown>> {
  return (readConfig().llm as { profiles: Record<string, never> }).profiles;
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "custom-profile-ensure-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("ensureCompleteCustomProfiles", () => {
  test("materializes a partial custom profile against llm.default", () => {
    writeConfig({
      llm: {
        default: distinctiveDefault,
        profiles: {
          partial: { source: "user", model: "claude-haiku-4-5-20251001" },
        },
      },
    });
    ensureCompleteCustomProfiles(workspaceDir);
    const saved = readProfiles().partial;
    expect(saved.model).toBe("claude-haiku-4-5-20251001");
    expect(saved.provider).toBe("anthropic");
    expect(saved.provider_connection).toBe("anthropic-personal");
    expect(saved.maxTokens).toBe(12345);
    expect(saved.temperature).toBe(0.7);
    expect(saved.logitBias).toBeUndefined();
    expect(saved.thinking).toBeDefined();
    expect(saved.contextWindow).toBeDefined();
  });

  test("implies the catalog provider for a model llm.default's provider does not serve", () => {
    writeConfig({
      llm: {
        default: distinctiveDefault,
        profiles: { gpt: { source: "user", model: "gpt-5.5" } },
      },
    });
    ensureCompleteCustomProfiles(workspaceDir);
    const saved = readProfiles().gpt;
    expect(saved.provider).toBe("openai");
    // anthropic-personal belongs to the replaced provider.
    expect(saved.provider_connection).toBeUndefined();
  });

  test("inherits the vellum managed connection only onto managed-routable providers", () => {
    writeConfig({
      llm: {
        default: { ...distinctiveDefault, provider_connection: "vellum" },
        profiles: {
          gpt: { source: "user", model: "gpt-5.5" },
          router: {
            source: "user",
            provider: "openrouter",
            model: "minimax/minimax-m3",
          },
        },
      },
    });
    ensureCompleteCustomProfiles(workspaceDir);
    expect(readProfiles().gpt.provider_connection).toBe("vellum");
    expect(readProfiles().router.provider_connection).toBeUndefined();
  });

  test("leaves managed stubs, mixes, complete profiles, and unparseable entries untouched", () => {
    const complete = {
      source: "user",
      ...LLMConfigBase.parse({ ...distinctiveDefault }),
    };
    // LLMConfigBase carries null sampling defaults ProfileEntry omits.
    delete (complete as Record<string, unknown>).logitBias;
    const config = {
      llm: {
        default: distinctiveDefault,
        profiles: {
          balanced: { source: "managed", status: "disabled" },
          ab: {
            source: "user",
            mix: [
              { profile: "a", weight: 1 },
              { profile: "b", weight: 1 },
            ],
          },
          complete,
          broken: { maxTokens: "not-a-number" },
          scalar: "not-an-object",
        },
      },
    };
    writeConfig(config);
    const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    ensureCompleteCustomProfiles(workspaceDir);
    const after = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(after).toBe(before);
  });

  test("preserves unknown keys on materialized entries", () => {
    writeConfig({
      llm: {
        default: distinctiveDefault,
        profiles: {
          partial: {
            source: "user",
            model: "claude-haiku-4-5-20251001",
            futureField: "keep-me",
          },
        },
      },
    });
    ensureCompleteCustomProfiles(workspaceDir);
    expect(readProfiles().partial.futureField).toBe("keep-me");
    expect(readProfiles().partial.provider).toBe("anthropic");
  });

  test("does not bake null default sampling; preserves explicit profile null", () => {
    writeConfig({
      llm: {
        default: { ...distinctiveDefault, temperature: null, topP: null },
        profiles: {
          plain: { source: "user", model: "claude-haiku-4-5-20251001" },
          cleared: {
            source: "user",
            model: "claude-haiku-4-5-20251001",
            temperature: null,
          },
        },
      },
    });
    ensureCompleteCustomProfiles(workspaceDir);
    expect("temperature" in readProfiles().plain).toBe(false);
    expect(readProfiles().cleared.temperature).toBeNull();
  });

  test("is idempotent — the second run rewrites nothing", () => {
    writeConfig({
      llm: {
        default: distinctiveDefault,
        profiles: {
          partial: { source: "user", model: "claude-haiku-4-5-20251001" },
        },
      },
    });
    ensureCompleteCustomProfiles(workspaceDir);
    const first = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    ensureCompleteCustomProfiles(workspaceDir);
    const second = readFileSync(join(workspaceDir, "config.json"), "utf-8");
    expect(second).toBe(first);
  });

  test("no-ops on adversarial config shapes", () => {
    // Missing file.
    ensureCompleteCustomProfiles(workspaceDir);
    // Unparseable JSON.
    writeFileSync(join(workspaceDir, "config.json"), "{nope");
    ensureCompleteCustomProfiles(workspaceDir);
    // Non-object root, missing llm, missing profiles, unparseable default.
    for (const config of [
      [1, 2],
      {},
      { llm: {} },
      { llm: { default: { provider: "not-a-provider" }, profiles: {} } },
      {
        llm: {
          default: { maxTokens: "NaN" },
          profiles: { p: { source: "user", model: "gpt-5.5" } },
        },
      },
    ]) {
      writeConfig(config);
      const before = readFileSync(join(workspaceDir, "config.json"), "utf-8");
      ensureCompleteCustomProfiles(workspaceDir);
      expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
        before,
      );
    }
  });
});
