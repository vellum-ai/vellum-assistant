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

  test("never inherits temperature, topP, or logitBias", () => {
    const dflt = LLMConfigBase.parse({
      ...fullDefault,
      temperature: 0.7,
      topP: 0.9,
      logitBias: "suppress-cjk",
    });
    const completed = completeCustomProfile(dflt, { model: "claude-fable-5" });
    expect(completed.temperature).toBeUndefined();
    expect(completed.topP).toBeUndefined();
    expect(completed.logitBias).toBeUndefined();
    // The profile's own sampling values are preserved untouched.
    const own = completeCustomProfile(dflt, { temperature: 0.2 });
    expect(own.temperature).toBe(0.2);
    expect(own.topP).toBeUndefined();
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
    // anthropic-personal belongs to the replaced provider; dispatch
    // auto-resolves an absent connection by provider, same as the partial
    // profile resolves today.
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

  test("always inherits the provider-agnostic vellum managed connection, even across an implied provider change", () => {
    const managedDefault = LLMConfigBase.parse({
      ...fullDefault,
      provider_connection: VELLUM_MANAGED_CONNECTION_NAME,
    });
    // Model implication flips the provider, but the vellum connection routes
    // any managed provider via `expectedProvider` — dropping it would cut the
    // profile off from platform-proxy routing.
    const implied = completeCustomProfile(managedDefault, { model: "gpt-5.5" });
    expect(implied.provider).toBe("openai");
    expect(implied.provider_connection).toBe(VELLUM_MANAGED_CONNECTION_NAME);

    const explicit = completeCustomProfile(managedDefault, {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(explicit.provider_connection).toBe(VELLUM_MANAGED_CONNECTION_NAME);
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

  const resolveWith = (profile: ProfileEntry) => {
    const llm = LLMSchema.parse({
      default: fullDefault,
      profiles: { "custom-x": { source: "user", ...profile } },
    });
    return resolveCallSiteConfig("vision", llm, {
      overrideProfile: "custom-x",
    });
  };

  for (const [name, partial] of Object.entries(PARTIALS)) {
    test(`partial and completed resolve identically: ${name}`, () => {
      const completed = completeCustomProfile(fullDefault, {
        source: "user",
        ...partial,
      });
      expect(resolveWith(completed)).toEqual(resolveWith(partial));
    });
  }
});
