import { describe, expect, test } from "bun:test";

import { VELLUM_MANAGED_CONNECTION_NAME } from "../../providers/vellum-model-routing.js";
import { resolveCallSiteConfig } from "../llm-resolver.js";
import { completeCustomProfile } from "../profile-materialization.js";
import { LLMConfigBase, LLMSchema, ProfileEntry } from "../schemas/llm.js";

const fullDefault = LLMConfigBase.parse({
  provider: "anthropic",
  provider_connection: "anthropic-personal",
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
  test("inherits omitted scalar fields from the default", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "claude-fable-5",
    });
    expect(completed.model).toBe("claude-fable-5");
    expect(completed.provider).toBe("anthropic");
    expect(completed.provider_connection).toBe("anthropic-personal");
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

  test("keeps the inherited provider when it serves the profile's model", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "claude-fable-5",
    });
    expect(completed.provider).toBe("anthropic");
    expect(completed.provider_connection).toBe("anthropic-personal");
  });

  test("stamps the catalog owner for a model the default provider does not serve, and drops the default's connection", () => {
    const completed = completeCustomProfile(fullDefault, { model: "gpt-5.5" });
    expect(completed.provider).toBe("openai");
    // Provider-specific connections don't cross providers; dispatch
    // auto-resolves an absent connection.
    expect(completed.provider_connection).toBeUndefined();
  });

  test("keeps an explicit provider_connection even when the provider is implied", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "gpt-5.5",
      provider_connection: "my-openai",
    });
    expect(completed.provider).toBe("openai");
    expect(completed.provider_connection).toBe("my-openai");
  });

  test("does not inherit the default's connection onto an explicit different provider", () => {
    const completed = completeCustomProfile(fullDefault, {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(completed.provider).toBe("openai");
    expect(completed.provider_connection).toBeUndefined();
  });

  test("inherits the vellum managed connection across a provider change, but only onto managed-routable providers", () => {
    const managedDefault = LLMConfigBase.parse({
      ...fullDefault,
      provider_connection: VELLUM_MANAGED_CONNECTION_NAME,
    });
    const implied = completeCustomProfile(managedDefault, { model: "gpt-5.5" });
    expect(implied.provider).toBe("openai");
    expect(implied.provider_connection).toBe(VELLUM_MANAGED_CONNECTION_NAME);

    const explicit = completeCustomProfile(managedDefault, {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(explicit.provider_connection).toBe(VELLUM_MANAGED_CONNECTION_NAME);

    // The vellum connection can't route a non-managed provider; baking it in
    // would fail dispatch's mismatch path instead of auto-resolving.
    const nonRoutable = completeCustomProfile(managedDefault, {
      provider: "openrouter",
      model: "minimax/minimax-m3",
    });
    expect(nonRoutable.provider_connection).toBeUndefined();
  });

  test("keeps the inherited provider for a model unknown to the catalog", () => {
    const completed = completeCustomProfile(fullDefault, {
      model: "totally-custom-model",
    });
    expect(completed.provider).toBe("anthropic");
    expect(completed.provider_connection).toBe("anthropic-personal");
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

// Equivalence with the live deep-merge resolver: on a profile-less call site
// with no activeProfile, the custom profile is the only profile layer above
// `llm.default`, which is exactly the standalone meaning materialization
// bakes in. Partial and completed forms must resolve identically — this is
// the contract that lets migration 128 rewrite profiles without changing
// behavior under the current resolver, and lets the M6 resolver treat the
// completed form as the profile's full meaning.
//
// (Deliberately NOT covered: a partial profile layered above other profiles
// — e.g. mainAgent activeProfile above the balanced call-site layer — where
// omitted fields inherit from the mid layer today. That context-dependent
// meaning is unrepresentable as a single complete profile; the standalone
// reading is the one that ships. See the M6 plan, Behavior changes #4.)
describe("completeCustomProfile — resolver equivalence", () => {
  const PARTIALS: Record<string, ProfileEntry> = {
    empty: {},
    "model only, served by default provider": { model: "claude-fable-5" },
    "model only, implies another provider": { model: "gpt-5.5" },
    "sampling only": { temperature: 0.3 },
    "explicit null sampling": { temperature: null },
    "nested thinking fragment": { thinking: { enabled: false } },
    "tokens and effort": { maxTokens: 1234, effort: "low" },
    "explicit cross-provider without connection": {
      provider: "openai",
      model: "gpt-5.4",
    },
    "complete profile": {
      provider: "openai",
      model: "gpt-5.4",
      provider_connection: "openai-personal",
      maxTokens: 9000,
      effort: "high",
      temperature: 0.1,
      topP: 0.5,
    },
    "metadata alongside config": {
      model: "gpt-5.5",
      label: "My GPT",
      description: "d",
      status: "active",
    },
  };

  // Run the whole matrix against two defaults: the schema-typical null
  // sampling, and a default with non-null temperature/topP — the latter is
  // what catches sampling-inheritance regressions (null defaults make those
  // cases pass vacuously).
  const DEFAULTS: Record<string, LLMConfigBase> = {
    "null sampling": fullDefault,
    "non-null sampling": LLMConfigBase.parse({
      ...fullDefault,
      temperature: 0.7,
      topP: 0.9,
    }),
  };

  const resolveWith = (dflt: LLMConfigBase, profile: ProfileEntry) => {
    const llm = LLMSchema.parse({
      default: dflt,
      profiles: { "custom-x": { source: "user", ...profile } },
    });
    return resolveCallSiteConfig("vision", llm, {
      overrideProfile: "custom-x",
    });
  };

  for (const [defaultName, dflt] of Object.entries(DEFAULTS)) {
    for (const [name, partial] of Object.entries(PARTIALS)) {
      test(`partial and completed resolve identically (${defaultName} default): ${name}`, () => {
        const completed = completeCustomProfile(dflt, {
          source: "user",
          ...partial,
        });
        expect(resolveWith(dflt, completed)).toEqual(
          resolveWith(dflt, partial),
        );
      });
    }
  }
});
