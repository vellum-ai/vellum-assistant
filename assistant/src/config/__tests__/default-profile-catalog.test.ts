import { describe, expect, test } from "bun:test";

import { resolveRoutingIdentity } from "../../providers/connection-resolution.js";
import { resolveModelIntent } from "../../providers/model-intents.js";
import { CALL_SITE_DEFAULTS } from "../call-site-defaults.js";
import {
  CODE_DEFAULT_PROFILE_ENTRIES,
  getEffectiveProfile,
  getEffectiveProfiles,
  resolveDefaultProfileForProvider,
} from "../default-profile-catalog.js";
import {
  DEFAULT_PROFILE_KEYS,
  DEFAULT_PROFILE_PROVIDERS,
  OS_BETA_PROFILE_KEY,
} from "../default-profile-names.js";
import {
  resolveCallSiteConfig,
  resolveDefaultProfileKey,
} from "../llm-resolver.js";
import {
  type LLMCallSite,
  LLMSchema,
  type ProfileEntry,
} from "../schemas/llm.js";

/** Thin managed-source stubs: a workspace that carries only ownership
 * markers for the defaults, no profile content. */
function managedStubs(): Record<string, ProfileEntry> {
  return Object.fromEntries(
    DEFAULT_PROFILE_KEYS.map((key) => [key, { source: "managed" as const }]),
  );
}

describe("getEffectiveProfiles", () => {
  test("the code catalog materializes a full body for every default profile", () => {
    for (const key of [...DEFAULT_PROFILE_KEYS, OS_BETA_PROFILE_KEY]) {
      const body = CODE_DEFAULT_PROFILE_ENTRIES[key];
      expect(body).toBeDefined();
      expect(typeof body.model).toBe("string");
      expect(body.provider).toBe("vellum");
      expect(body.provider_connection).toBeUndefined();
      expect(body.source).toBe("managed");
    }
  });

  test("every vellum-column body translates to a managed dispatch target", () => {
    for (const key of [...DEFAULT_PROFILE_KEYS, OS_BETA_PROFILE_KEY]) {
      const body = CODE_DEFAULT_PROFILE_ENTRIES[key];
      const identity = resolveRoutingIdentity(body.provider, body.model);
      expect(identity?.connectionName).toBe("vellum");
      expect(typeof identity?.expectedProvider).toBe("string");
    }
  });

  test("defaults absent from the workspace resolve from the catalog; os-beta stays flag-gated", () => {
    const effective = getEffectiveProfiles(undefined);
    expect(Object.keys(effective).sort()).toEqual(
      [...DEFAULT_PROFILE_KEYS].sort(),
    );
    expect(getEffectiveProfile({}, "balanced")?.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(getEffectiveProfile({}, OS_BETA_PROFILE_KEY)).toBeUndefined();
  });

  test("a managed-source entry resolves to the code body with only label/status/topP from disk", () => {
    const workspace: Record<string, ProfileEntry> = {
      balanced: {
        source: "managed",
        label: "Balanced (Managed)",
        status: "disabled",
        topP: 0.7,
        // Stale content drift on disk must lose to the code default body.
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 1,
      },
    };
    const entry = getEffectiveProfile(workspace, "balanced");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Balanced (Managed)");
    expect(entry?.status).toBe("disabled");
    expect(entry?.topP).toBe(0.7);
    expect(entry?.model).toBe(CODE_DEFAULT_PROFILE_ENTRIES.balanced.model);
    expect(String(entry?.provider)).toBe(
      String(CODE_DEFAULT_PROFILE_ENTRIES.balanced.provider),
    );
    expect(entry?.maxTokens).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.maxTokens,
    );
  });

  test("a user-owned profile sharing a default name wins verbatim", () => {
    const workspace: Record<string, ProfileEntry> = {
      balanced: {
        source: "user",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        maxTokens: 1000,
      },
    };
    expect(getEffectiveProfile(workspace, "balanced")).toBe(workspace.balanced);
  });

  test("custom profiles pass through untouched", () => {
    const workspace: Record<string, ProfileEntry> = {
      ...managedStubs(),
      "my-custom": { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const effective = getEffectiveProfiles(workspace);
    expect(effective["my-custom"]).toBe(workspace["my-custom"]);
    expect(effective.balanced.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
  });

  test("an injected catalog changes the effective view without any workspace change", () => {
    const workspace = managedStubs();
    const stubCatalog: Record<string, ProfileEntry> = {
      balanced: {
        ...CODE_DEFAULT_PROFILE_ENTRIES.balanced,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    };
    const before = getEffectiveProfiles(workspace);
    const after = getEffectiveProfiles(workspace, stubCatalog);
    expect(before.balanced.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(after.balanced.model).toBe("claude-sonnet-4-6");
  });
});

describe("resolver integration", () => {
  test("resolution serves default-profile content from the code catalog, not the workspace body", () => {
    // The headline milestone test: with only thin managed stubs on disk,
    // resolution comes entirely from the code catalog — shipping a release
    // with a new catalog body changes resolution with no workspace
    // migration.
    const llm = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: managedStubs(),
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(String(resolved.provider)).toBe("vellum");
    expect(resolved.provider_connection).toBeUndefined();
  });

  test("an empty workspace resolves every call-site default from the catalog", () => {
    const llm = LLMSchema.parse({ activeProfile: "balanced" });
    for (const [callSite, dflt] of Object.entries(CALL_SITE_DEFAULTS)) {
      if (dflt.profile == null) {
        continue;
      }
      const expected = CODE_DEFAULT_PROFILE_ENTRIES[dflt.profile];
      const resolved = resolveCallSiteConfig(callSite as LLMCallSite, llm);
      // A site-level model pin (e.g. voiceFrontDecision's latency pin)
      // legitimately overrides the profile's model.
      expect(resolved.model).toBe((dflt.model ?? expected.model) as string);
    }
  });

  test("memoryV3SelectL2 pins the haiku model over a managed route so its cache breakpoint engages", () => {
    // The selector's ~30k-token card-corpus prefix carries a `cache_control`
    // breakpoint that only an Anthropic-protocol model honors (the caller
    // stamps a 1h TTL, but the provider serves it at the default 5m TTL on the
    // haiku family). The call-site default pins `claude-haiku-4-5-20251001` as
    // a bare model pin: on a managed install the balanced winner is the
    // `vellum` routing identity, and the managed route serves the
    // anthropic-catalog model, so the pin keeps the provider-agnostic managed
    // connection and just swaps the model.
    const llm = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: managedStubs(),
    });
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm);
    expect(String(resolved.provider)).toBe("vellum");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider_connection).toBeUndefined();
    // Sampling/thinking tweaks from the call-site default survive the pin.
    expect(resolved.temperature).toBe(0);
    expect(resolved.thinking.enabled).toBe(false);
    expect(resolved.thinking.streamThinking).toBe(false);
    // The managed route dispatches the pinned model to its Anthropic upstream —
    // this is what makes the Anthropic `cache_control` breakpoint effective.
    const identity = resolveRoutingIdentity(resolved.provider, resolved.model);
    expect(identity?.connectionName).toBe("vellum");
    expect(identity?.expectedProvider).toBe("anthropic");
  });

  test("memoryV3SelectL2 drops the unreachable haiku pin on a BYOK install and runs the balanced-profile model", () => {
    // BYOK install: openai is the default provider and there is no Anthropic
    // connection. The haiku pin's catalog provider (anthropic) is reachable
    // through neither managed routing nor a matching connection, so the pin is
    // dropped and the call site's balanced profile — resolved through the
    // openai default provider — supplies the model. Without this, the resolved
    // config would name `provider: anthropic` with no connection and fail every
    // dispatch.
    const llm = LLMSchema.parse({
      profiles: managedStubs(),
      defaultProvider: { provider: "openai" },
    });
    const fallbacks: { requested: string; reason: string }[] = [];
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm, {
      onResolutionFallback: ({ requested, reason }) =>
        fallbacks.push({ requested, reason }),
    });
    const balancedOnOpenai = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      {
        provider: "openai",
      },
    );
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe(balancedOnOpenai?.model as string);
    expect(resolved.model).not.toBe("claude-haiku-4-5-20251001");
    // The winner's own connection survives — resolution stays dispatchable.
    expect(resolved.provider_connection).toBe(
      balancedOnOpenai?.provider_connection,
    );
    expect(resolved.provider_connection).toBeDefined();
    // Sampling/thinking tweaks from the call-site default are provider-agnostic
    // and still apply.
    expect(resolved.temperature).toBe(0);
    expect(resolved.thinking.enabled).toBe(false);
    // The drop is reported so user-facing paths can log it.
    expect(fallbacks).toContainEqual({
      requested: "claude-haiku-4-5-20251001",
      reason: "unroutable",
    });
  });

  test("voiceFront call sites drop the unreachable haiku pin on a BYOK install", () => {
    const llm = LLMSchema.parse({
      profiles: managedStubs(),
      defaultProvider: { provider: "openai" },
    });
    const costOptimizedOnOpenai = resolveDefaultProfileForProvider(
      undefined,
      "cost-optimized",
      { provider: "openai" },
    );
    for (const callSite of ["voiceFrontDecision", "voiceFrontDoor"] as const) {
      const resolved = resolveCallSiteConfig(callSite, llm);
      expect(resolved.provider).toBe("openai");
      expect(resolved.model).toBe(costOptimizedOnOpenai?.model as string);
      expect(resolved.model).not.toBe("claude-haiku-4-5-20251001");
      expect(resolved.provider_connection).toBeDefined();
    }
  });

  test("a BYOK install whose default provider IS anthropic keeps the haiku pin", () => {
    // The winner (balanced through anthropic) already serves the anthropic
    // catalog model, so the pin is honored on its own connection — no drop.
    const llm = LLMSchema.parse({
      profiles: managedStubs(),
      defaultProvider: { provider: "anthropic" },
    });
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm);
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider_connection).toBe("anthropic-personal");
  });

  test("an explicit user profile pin outranks the call-site default and its model pin", () => {
    // On the same BYOK-openai install, a user who points the call site at their
    // own profile gets that profile verbatim — the shipped haiku pin never
    // enters resolution.
    const llm = LLMSchema.parse({
      profiles: {
        ...managedStubs(),
        "my-openai": {
          source: "user",
          provider: "openai",
          provider_connection: "openai-personal",
          model: "gpt-5.5",
        },
      },
      defaultProvider: { provider: "openai" },
      callSites: { memoryV3SelectL2: { profile: "my-openai" } },
    });
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-5.5");
  });

  test("an explicit user model pin is honored as written even when unreachable", () => {
    // The graceful drop is scoped to shipped call-site DEFAULT pins. A
    // deliberate user model override still stamps the catalog provider (and
    // drops the winner's connection), preserving the existing contract — a
    // user's explicit choice is never silently swapped.
    const llm = LLMSchema.parse({
      profiles: managedStubs(),
      defaultProvider: { provider: "openai" },
      callSites: { memoryV3SelectL2: { model: "claude-haiku-4-5-20251001" } },
    });
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm);
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.provider_connection).toBeUndefined();
  });

  test("a tuning-only override keeps the shipped haiku pin on a managed install", () => {
    // A workspace override that sets neither `profile` nor its own `model`
    // (here just `temperature`) replaces the shipped call-site default
    // wholesale. The resolver re-applies the shipped model as a default-owned
    // pin, so on a managed install the pin still resolves to the haiku model
    // over the provider-agnostic managed route — the override tunes sampling
    // without silently disabling the pin.
    const llm = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: managedStubs(),
      callSites: { memoryV3SelectL2: { temperature: 0.2 } },
    });
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm);
    expect(String(resolved.provider)).toBe("vellum");
    expect(resolved.model).toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider_connection).toBeUndefined();
    // The override's own tuning wins.
    expect(resolved.temperature).toBe(0.2);
  });

  test("a tuning-only override drops the unreachable haiku pin on a BYOK install", () => {
    // Same tuning-only override on a BYOK-openai install with no Anthropic
    // connection. The inherited haiku pin is default-owned, so it gets the
    // graceful `unroutable` drop: resolution falls back to the balanced profile
    // through openai, stays dispatchable, and reports the drop — no error, and
    // the override's own tuning still applies.
    const llm = LLMSchema.parse({
      profiles: managedStubs(),
      defaultProvider: { provider: "openai" },
      callSites: { memoryV3SelectL2: { temperature: 0.2 } },
    });
    const fallbacks: { requested: string; reason: string }[] = [];
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm, {
      onResolutionFallback: ({ requested, reason }) =>
        fallbacks.push({ requested, reason }),
    });
    const balancedOnOpenai = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      { provider: "openai" },
    );
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe(balancedOnOpenai?.model as string);
    expect(resolved.model).not.toBe("claude-haiku-4-5-20251001");
    expect(resolved.provider_connection).toBe(
      balancedOnOpenai?.provider_connection,
    );
    expect(resolved.provider_connection).toBeDefined();
    expect(resolved.temperature).toBe(0.2);
    expect(fallbacks).toContainEqual({
      requested: "claude-haiku-4-5-20251001",
      reason: "unroutable",
    });
  });

  test("a profile override outranks the shipped pin on a managed install too", () => {
    // The shipped pin is selection, not tuning: pointing the call site at a
    // profile means the winner supplies the model and the shipped haiku pin
    // never enters resolution — on a managed install as well as the BYOK case
    // above. Neither `profile` nor `model` is inherited from the shipped
    // default when the user names a profile.
    const llm = LLMSchema.parse({
      profiles: managedStubs(),
      callSites: { memoryV3SelectL2: { profile: "cost-optimized" } },
    });
    const resolved = resolveCallSiteConfig("memoryV3SelectL2", llm);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES["cost-optimized"].model as string,
    );
    expect(resolved.model).not.toBe("claude-haiku-4-5-20251001");
  });

  test("thin managed stubs and fully seeded bodies resolve identically at every call site", () => {
    const seededProfiles = Object.fromEntries(
      Object.entries(CODE_DEFAULT_PROFILE_ENTRIES).filter(
        ([name]) => name !== OS_BETA_PROFILE_KEY,
      ),
    );
    const seeded = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: seededProfiles,
    });
    const stubbed = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: managedStubs(),
    });
    for (const callSite of Object.keys(CALL_SITE_DEFAULTS)) {
      expect(resolveCallSiteConfig(callSite as LLMCallSite, stubbed)).toEqual(
        resolveCallSiteConfig(callSite as LLMCallSite, seeded),
      );
    }
  });

  test("a disabled managed default does not divert resolution to the custom-* clone", () => {
    const llm = LLMSchema.parse({
      profiles: {
        balanced: { source: "managed", status: "disabled" },
        "custom-balanced": {
          source: "user",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 1000,
        },
      },
    });
    // The fallback anchor is the code-owned intent: a legacy disabled stub
    // does not suppress it, and the user-mutable custom-* clone never
    // captures the call site.
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("balanced");
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(resolved.model).not.toBe("claude-sonnet-4-6");
  });
});

describe("schema validation", () => {
  test("always-available default names are valid references; os-beta only when materialized", () => {
    expect(() => LLMSchema.parse({ activeProfile: "balanced" })).not.toThrow();
    expect(() =>
      LLMSchema.parse({ advisorProfile: "quality-optimized" }),
    ).not.toThrow();
    expect(() =>
      LLMSchema.parse({
        callSites: { mainAgent: { profile: "cost-optimized" } },
      }),
    ).not.toThrow();
    // Flag-gated: valid only while its workspace stub exists.
    expect(() =>
      LLMSchema.parse({ activeProfile: OS_BETA_PROFILE_KEY }),
    ).toThrow();
    expect(() =>
      LLMSchema.parse({
        activeProfile: OS_BETA_PROFILE_KEY,
        profiles: { [OS_BETA_PROFILE_KEY]: { source: "managed" } },
      }),
    ).not.toThrow();
    expect(() =>
      LLMSchema.parse({ callSites: { mainAgent: { profile: "no-such" } } }),
    ).toThrow();
  });
});

describe("resolveDefaultProfileForProvider", () => {
  const dp = (
    provider: (typeof DEFAULT_PROFILE_PROVIDERS)[number],
    connectionName?: string,
  ) => ({ provider, ...(connectionName ? { connectionName } : {}) });

  test("every matrix column materializes every default profile key", () => {
    for (const provider of DEFAULT_PROFILE_PROVIDERS) {
      for (const key of DEFAULT_PROFILE_KEYS) {
        const entry = resolveDefaultProfileForProvider(
          undefined,
          key,
          dp(provider),
        );
        expect(entry).toBeDefined();
        expect(typeof entry?.model).toBe("string");
        expect(entry?.provider).toBeDefined();
        // Identity columns stamp no connection; BYOK columns always do.
        if (entry?.provider === "vellum") {
          expect(entry?.provider_connection).toBeUndefined();
        } else {
          expect(entry?.provider_connection).toBeDefined();
        }
        expect(entry?.source).toBe("managed");
      }
    }
  });

  test("BYOK columns resolve the intent to a provider-specific model and personal connection", () => {
    const entry = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      dp("anthropic"),
    );
    expect(entry?.provider).toBe("anthropic");
    expect(entry?.provider_connection).toBe("anthropic-personal");
    expect(entry?.model).toBe(resolveModelIntent("anthropic", "balanced"));
  });

  test("the vellum column keeps its underlying dispatch provider and managed connection", () => {
    const entry = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      dp("vellum"),
    );
    // `vellum` is a routing identity: balanced dispatches through fireworks.
    expect(entry?.provider).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.provider,
    );
    expect(entry?.provider_connection).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.provider_connection,
    );
    expect(entry?.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
  });

  test("an explicit connectionName wins over the convention", () => {
    const entry = resolveDefaultProfileForProvider(
      undefined,
      "balanced",
      dp("openai", "work-openai"),
    );
    expect(entry?.provider).toBe("openai");
    expect(entry?.provider_connection).toBe("work-openai");
  });

  test("a user-source workspace entry shadows the provider-resolved default", () => {
    const workspace: Record<string, ProfileEntry> = {
      balanced: { source: "user", provider: "openai", model: "gpt-5.5" },
    };
    const entry = resolveDefaultProfileForProvider(
      workspace,
      "balanced",
      dp("anthropic"),
    );
    expect(entry).toBe(workspace.balanced);
  });

  test("a managed-source stub contributes only label/status/topP over the provider-resolved body", () => {
    const workspace: Record<string, ProfileEntry> = {
      balanced: {
        source: "managed",
        label: "Balanced (BYOK)",
        status: "disabled",
        topP: 0.7,
        model: "stale-model-should-be-ignored",
      },
    };
    const entry = resolveDefaultProfileForProvider(
      workspace,
      "balanced",
      dp("gemini"),
    );
    expect(entry?.label).toBe("Balanced (BYOK)");
    expect(entry?.status).toBe("disabled");
    expect(entry?.topP).toBe(0.7);
    expect(entry?.provider).toBe("gemini");
    expect(entry?.model).toBe(resolveModelIntent("gemini", "balanced"));
    expect(entry?.provider_connection).toBe("gemini-personal");
  });

  test("a null defaultProvider falls back to the vellum code bodies", () => {
    for (const key of DEFAULT_PROFILE_KEYS) {
      expect(resolveDefaultProfileForProvider(undefined, key, null)).toEqual(
        getEffectiveProfile(undefined, key) as ProfileEntry,
      );
    }
  });

  test("non-matrix names pass through like getEffectiveProfile", () => {
    const workspace: Record<string, ProfileEntry> = {
      "custom-mine": { source: "user", provider: "openai", model: "gpt-5.4" },
    };
    expect(
      resolveDefaultProfileForProvider(
        workspace,
        "custom-mine",
        dp("anthropic"),
      ),
    ).toBe(workspace["custom-mine"]);
    expect(
      resolveDefaultProfileForProvider(workspace, "no-such", dp("anthropic")),
    ).toBeUndefined();
  });

  test("os-beta stays flag-gated and provider-independent", () => {
    expect(
      resolveDefaultProfileForProvider(
        undefined,
        OS_BETA_PROFILE_KEY,
        dp("anthropic"),
      ),
    ).toBeUndefined();
    const workspace: Record<string, ProfileEntry> = {
      [OS_BETA_PROFILE_KEY]: { source: "managed" },
    };
    const entry = resolveDefaultProfileForProvider(
      workspace,
      OS_BETA_PROFILE_KEY,
      dp("anthropic"),
    );
    // The os-beta body never varies with the default provider.
    expect(entry?.provider).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES[OS_BETA_PROFILE_KEY].provider,
    );
  });

  test("agrees with getEffectiveProfile for the vellum default provider", () => {
    for (const key of DEFAULT_PROFILE_KEYS) {
      expect(
        resolveDefaultProfileForProvider(undefined, key, dp("vellum")),
      ).toEqual(getEffectiveProfile(undefined, key) as ProfileEntry);
    }
  });
});
