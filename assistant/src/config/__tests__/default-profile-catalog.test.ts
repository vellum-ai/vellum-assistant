import { describe, expect, test } from "bun:test";

import { CALL_SITE_DEFAULTS } from "../call-site-defaults.js";
import {
  CODE_DEFAULT_PROFILE_ENTRIES,
  getEffectiveProfile,
  getEffectiveProfiles,
} from "../default-profile-catalog.js";
import {
  DEFAULT_PROFILE_KEYS,
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

/** Thin managed-source stubs: what a workspace looks like once default
 * profile CONTENT is code-owned — only ownership/status markers on disk. */
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
      expect(body.provider).toBeDefined();
      expect(body.provider_connection).toBe("vellum");
      expect(body.source).toBe("managed");
    }
  });

  test("defaults absent from the workspace do not resolve (seeder still owns materialization)", () => {
    expect(getEffectiveProfiles(undefined)).toEqual({});
    expect(getEffectiveProfile({}, "balanced")).toBeUndefined();
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
    // The headline milestone test: with only thin managed stubs on disk (the
    // PR2 end state), resolution comes entirely from the code catalog — so
    // shipping a release with a new catalog body changes resolution with no
    // workspace migration.
    const llm = LLMSchema.parse({
      activeProfile: "balanced",
      profiles: managedStubs(),
    });
    const resolved = resolveCallSiteConfig("mainAgent", llm);
    expect(resolved.model).toBe(
      CODE_DEFAULT_PROFILE_ENTRIES.balanced.model as string,
    );
    expect(String(resolved.provider)).toBe(
      String(CODE_DEFAULT_PROFILE_ENTRIES.balanced.provider),
    );
    expect(resolved.provider_connection).toBe("vellum");
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
  test("profile references are valid only when materialized in llm.profiles (parity with the seeder contract)", () => {
    // A default name is not schema-valid while unmaterialized: the effective
    // view does not resolve absent defaults yet, so accepting the reference
    // would let resolution throw at dispatch. The ownership-flip follow-up
    // makes absent defaults resolve from the catalog and relaxes this.
    expect(() => LLMSchema.parse({ activeProfile: "balanced" })).toThrow();
    expect(() =>
      LLMSchema.parse({ activeProfile: OS_BETA_PROFILE_KEY }),
    ).toThrow();
    expect(() =>
      LLMSchema.parse({
        activeProfile: "balanced",
        profiles: managedStubs(),
      }),
    ).not.toThrow();
    expect(() =>
      LLMSchema.parse({ callSites: { mainAgent: { profile: "no-such" } } }),
    ).toThrow();
  });
});
