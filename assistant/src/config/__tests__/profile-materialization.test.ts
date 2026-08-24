import { describe, expect, mock, test } from "bun:test";

// An entry-name provider resolves its catalog kind through its connection
// row, so the output-cap clamp needs a row store to read.
const connectionRows = new Map<string, { name: string; provider: string }>([
  ["local-ollama", { name: "local-ollama", provider: "ollama" }],
]);
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => ({}),
}));
mock.module("../../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    connectionRows.get(name) ?? null,
}));

import { completeCustomProfile } from "../profile-materialization.js";
import { LLMConfigBase, ProfileEntry } from "../schemas/llm.js";

const fullDefault = LLMConfigBase.parse({
  provider: "anthropic",
  model: "claude-opus-4-8",
  maxTokens: 64000,
  effort: "max",
  speed: "standard",
  verbosity: "medium",
  temperature: null,
  topP: null,
  thinking: { enabled: true, streamThinking: true },
  contextWindow: {
    enabled: true,
    maxInputTokens: 200000,
    overflowRecovery: { enabled: true, maxAttempts: 3 },
  },
});

describe("completeCustomProfile", () => {
  test("clamps a filled maxTokens to the model's catalog output cap", () => {
    const completed = completeCustomProfile(fullDefault, {
      provider: "ollama",
      model: "llama3.2",
    });
    expect(completed.maxTokens).toBe(4096);
  });

  test("clamps a filled maxTokens for an entry-name provider via its row's kind", () => {
    const completed = completeCustomProfile(fullDefault, {
      provider: "local-ollama",
      model: "llama3.2",
    });
    expect(completed.maxTokens).toBe(4096);
  });

  test("never clamps an explicit maxTokens", () => {
    const completed = completeCustomProfile(fullDefault, {
      provider: "ollama",
      model: "llama3.2",
      maxTokens: 64000,
    });
    expect(completed.maxTokens).toBe(64000);
  });

  test("inherits omitted scalar fields from the default", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "claude-fable-5",
    });
    expect(completed.model).toBe("claude-fable-5");
    expect(completed.provider).toBe("anthropic");
    expect(completed.maxTokens).toBe(64000);
    expect(completed.effort).toBe("max");
    expect(completed.speed).toBe("standard");
    expect(completed.verbosity).toBe("medium");
  });

  test("inherits non-null default sampling; never inherits logitBias or null sampling", () => {
    const dflt = LLMConfigBase.parse({
      ...fullDefault,
      temperature: 0.7,
      topP: 0.9,
      logitBias: "suppress-cjk",
    });
    const completed = completeCustomProfile(dflt, { model: "claude-fable-5" });
    expect(completed.temperature).toBe(0.7);
    expect(completed.topP).toBe(0.9);
    // The resolver deletes non-profile logitBias post-merge, unlike sampling.
    expect(completed.logitBias).toBeUndefined();
    const own = completeCustomProfile(dflt, { temperature: 0.2 });
    expect(own.temperature).toBe(0.2);
    expect(own.topP).toBe(0.9);
    const nullDefaults = completeCustomProfile(fullDefault, {});
    expect(nullDefaults.temperature).toBeUndefined();
    expect(nullDefaults.topP).toBeUndefined();
    // Explicit null differs from undefined: it clears the default's value.
    const explicitNull = completeCustomProfile(dflt, { temperature: null });
    expect(explicitNull.temperature).toBeNull();
  });

  test("merges partial nested thinking leaf-by-leaf", () => {
    const completed = completeCustomProfile(fullDefault, {
      thinking: { enabled: false },
    });
    expect(completed.thinking).toEqual({
      enabled: false,
      streamThinking: true,
    });
  });

  test("merges nested contextWindow leaves including overflowRecovery", () => {
    const completed = completeCustomProfile(fullDefault, {
      contextWindow: { overflowRecovery: { maxAttempts: 5 } },
    });
    expect(completed.contextWindow?.maxInputTokens).toBe(200000);
    expect(completed.contextWindow?.overflowRecovery?.maxAttempts).toBe(5);
    expect(completed.contextWindow?.overflowRecovery?.enabled).toBe(true);
  });

  test("keeps the default provider when it serves the model", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "claude-fable-5",
    });
    expect(completed.provider).toBe("anthropic");
  });

  test("stamps the catalog owner for a model the default provider does not serve", () => {
    const completed = completeCustomProfile(fullDefault, { model: "gpt-5.5" });
    expect(completed.provider).toBe("openai");
  });

  test("keeps an explicit routing-identity provider", () => {
    for (const provider of ["vellum", "chatgpt"] as const) {
      const completed = completeCustomProfile(fullDefault, {
        provider,
        model: "claude-fable-5",
      });
      expect(completed.provider).toBe(provider);
    }
  });

  test("keeps an explicit different provider", () => {
    const completed = completeCustomProfile(fullDefault, {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(completed.provider).toBe("openai");
  });

  test("keeps the default provider for a model unknown to the catalog", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "totally-custom-model",
    });
    expect(completed.provider).toBe("anthropic");
  });

  test("passes mix profiles through untouched", () => {
    const mix: ProfileEntry = {
      label: "A/B",
      mix: [
        { profile: "a", weight: 1 },
        { profile: "b", weight: 1 },
      ],
    };
    expect(completeCustomProfile(fullDefault, mix)).toBe(mix);
  });

  test("passes managed profiles through untouched", () => {
    const managed: ProfileEntry = { source: "managed", topP: 0.9 };
    expect(completeCustomProfile(fullDefault, managed)).toBe(managed);
  });

  test("preserves metadata fields", () => {
    const completed = completeCustomProfile(fullDefault, {
      source: "user",
      label: "Fast drafts",
      description: "cheap and quick",
      status: "disabled",
      model: "claude-haiku-4-5-20251001",
    });
    expect(completed.source).toBe("user");
    expect(completed.label).toBe("Fast drafts");
    expect(completed.description).toBe("cheap and quick");
    expect(completed.status).toBe("disabled");
  });

  test("is idempotent", () => {
    const partials: ProfileEntry[] = [
      {},
      { model: "gpt-5.5" },
      { temperature: 0.3 },
      { thinking: { enabled: false }, maxTokens: 1234 },
    ];
    for (const partial of partials) {
      const once = completeCustomProfile(fullDefault, partial);
      const twice = completeCustomProfile(fullDefault, once);
      expect(twice).toEqual(once);
    }
  });

  test("completed entries still parse as ProfileEntry", () => {
    const partials: ProfileEntry[] = [
      {},
      { model: "gpt-5.5" },
      { temperature: 0.3, label: "t" },
      { thinking: { enabled: false } },
    ];
    for (const partial of partials) {
      const completed = completeCustomProfile(fullDefault, partial);
      expect(() => ProfileEntry.parse(completed)).not.toThrow();
    }
  });

  test("does not alias the default's nested objects", () => {
    const completed = completeCustomProfile(fullDefault, {});
    expect(completed.thinking).toEqual(fullDefault.thinking);
    expect(completed.thinking).not.toBe(fullDefault.thinking);
    expect(completed.contextWindow).not.toBe(fullDefault.contextWindow);
  });
});
