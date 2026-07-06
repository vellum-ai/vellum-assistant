import { describe, expect, test } from "bun:test";

import { CALL_SITE_DEFAULTS } from "../call-site-defaults.js";
import {
  CODE_DEFAULT_PROFILE_ENTRIES,
  getEffectiveProfile,
  getEffectiveProfiles,
} from "../default-profile-catalog.js";
import { OS_BETA_PROFILE_KEY } from "../default-profile-names.js";
import {
  resolveCallSiteConfig,
  resolveDefaultProfileKey,
} from "../llm-resolver.js";
import {
  type LLMCallSite,
  LLMSchema,
  type ProfileEntry,
} from "../schemas/llm.js";

describe("getEffectiveProfiles", () => {
  test("serves code defaults when the workspace has no profiles", () => {
    const effective = getEffectiveProfiles(undefined);
    expect(Object.keys(effective).sort()).toEqual([
      "balanced",
      "cost-optimized",
      "quality-optimized",
    ]);
    expect(effective.balanced.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(effective.balanced.provider_connection).toBe("vellum");
    expect(effective[OS_BETA_PROFILE_KEY]).toBeUndefined();
  });

  test("overlays only workspace-owned fields on a managed-source entry", () => {
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
      "my-custom": { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const effective = getEffectiveProfiles(workspace);
    expect(effective["my-custom"]).toBe(workspace["my-custom"]);
    expect(effective.balanced).toBeDefined();
  });

  test("os-beta resolves only while the workspace carries the reconciled entry", () => {
    expect(getEffectiveProfile({}, OS_BETA_PROFILE_KEY)).toBeUndefined();
    const workspace: Record<string, ProfileEntry> = {
      [OS_BETA_PROFILE_KEY]: { source: "managed", status: "disabled" },
    };
    const entry = getEffectiveProfile(workspace, OS_BETA_PROFILE_KEY);
    expect(entry?.status).toBe("disabled");
    expect(entry?.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES[OS_BETA_PROFILE_KEY].model,
    );
  });

  test("an injected catalog changes the effective view without any workspace change", () => {
    const stubCatalog: Record<string, ProfileEntry> = {
      balanced: {
        ...CODE_DEFAULT_PROFILE_ENTRIES.balanced,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    };
    const before = getEffectiveProfiles({});
    const after = getEffectiveProfiles({}, stubCatalog);
    expect(before.balanced.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(after.balanced.model).toBe("claude-sonnet-4-6");
    expect(Object.keys(after)).toEqual(["balanced"]);
  });
});

describe("resolver integration", () => {
  test("default profiles resolve from the catalog when the workspace carries no bodies", () => {
    const llm = LLMSchema.parse({ activeProfile: "balanced" });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(String(resolved.provider)).toBe(
      String(CODE_DEFAULT_PROFILE_ENTRIES.balanced.provider),
    );
    expect(resolved.provider_connection).toBe("vellum");
  });

  test("resolution is identical whether or not the seeded bodies are in the workspace", () => {
    const seededProfiles = Object.fromEntries(
      Object.entries(CODE_DEFAULT_PROFILE_ENTRIES).filter(
        ([name]) => name !== OS_BETA_PROFILE_KEY,
      ),
    );
    const seeded = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: seededProfiles,
    });
    const bare = LLMSchema.parse({ activeProfile: "balanced" });
    for (const callSite of Object.keys(CALL_SITE_DEFAULTS)) {
      expect(resolveCallSiteConfig(callSite as LLMCallSite, bare)).toEqual(
        resolveCallSiteConfig(callSite as LLMCallSite, seeded),
      );
    }
  });

  test("a disabled managed default falls through to the custom-* profile", () => {
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
    expect(resolveDefaultProfileKey("mainAgent", llm)).toBe("custom-balanced");
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe("claude-sonnet-4-6");
  });
});

describe("schema validation", () => {
  test("accepts references to default profiles absent from llm.profiles", () => {
    expect(() => LLMSchema.parse({ activeProfile: "balanced" })).not.toThrow();
    expect(() =>
      LLMSchema.parse({ advisorProfile: "quality-optimized" }),
    ).not.toThrow();
    expect(() =>
      LLMSchema.parse({
        callSites: { mainAgent: { profile: "cost-optimized" } },
      }),
    ).not.toThrow();
  });

  test("still rejects references to unknown profile names", () => {
    expect(() => LLMSchema.parse({ activeProfile: "no-such" })).toThrow();
    expect(() =>
      LLMSchema.parse({ callSites: { mainAgent: { profile: "no-such" } } }),
    ).toThrow();
  });
});
