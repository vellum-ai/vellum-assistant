/**
 * Managed backup profiles and the `fallbackProfile` pointers of the vellum
 * column (`default-profile-catalog.ts`).
 *
 * The invariants under test:
 * - Every default profile's managed (vellum) implementation points at a
 *   backup profile that exists in the code catalog.
 * - Cross-provider rule: a backup pins its model at a DIFFERENT managed
 *   upstream than its primary, so an outage at the primary's provider can
 *   be served by the backup. Holds for the experiment arms too.
 * - Probe coverage: every backup model is a catalog member of its upstream
 *   provider, which is what feeds the platform's model liveness probe.
 * - Scoping: backups exist for the managed column only. A BYOK or chatgpt
 *   default provider materializes no backup profiles, and its primaries
 *   carry no `fallbackProfile` pointers.
 * - The effective catalog parses under `LLMSchema` (exercising the
 *   `fallbackProfile` superRefine against the real entries), and backups
 *   are delete-protected like the other managed defaults.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { BALANCED_MODEL_EXPERIMENT_FLAG_KEY } from "../config/balanced-model-experiment.js";
import {
  CODE_DEFAULT_PROFILE_ENTRIES,
  getEffectiveProfile,
  getEffectiveProfiles,
  getEffectiveProfilesForProvider,
  INVARIANT_PROFILE_NAMES,
  MANAGED_PROFILE_NAMES,
  MANAGED_PROFILE_TEMPLATES,
  PROFILE_IMPLS,
  resolveDefaultProfileForProvider,
} from "../config/default-profile-catalog.js";
import {
  BACKUP_PROFILE_KEYS,
  DEFAULT_PROFILE_KEYS,
  DEFAULT_PROFILE_PROVIDERS,
  FALLBACK_PROFILE_BY_KEY,
} from "../config/default-profile-names.js";
import { clearCachedOverrides } from "../config/feature-flag-cache.js";
import {
  type DefaultProviderConfig,
  LLMSchema,
  type ProfileEntry,
} from "../config/schemas/llm.js";
import { isModelInCatalog } from "../providers/model-catalog.js";
import { getManagedUpstream } from "../providers/vellum-model-routing.js";
import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

const vellum: DefaultProviderConfig = { provider: "vellum" };

afterEach(() => {
  clearCachedOverrides();
});

describe("fallbackProfile pointers on the vellum column", () => {
  test("every default profile's vellum impl points at an existing backup", () => {
    for (const key of DEFAULT_PROFILE_KEYS) {
      const impl = PROFILE_IMPLS[key].vellum;
      expect(impl.fallbackProfile).toBe(FALLBACK_PROFILE_BY_KEY[key]);
      const backup = CODE_DEFAULT_PROFILE_ENTRIES[FALLBACK_PROFILE_BY_KEY[key]];
      expect(backup).toBeDefined();
      expect(backup.provider).toBe("vellum");
      expect(backup.source).toBe("managed");
      // Single hop: a backup never declares a fallback of its own.
      expect(backup.fallbackProfile).toBeUndefined();
    }
  });

  test("no BYOK or chatgpt column impl carries fallbackProfile", () => {
    for (const key of DEFAULT_PROFILE_KEYS) {
      for (const provider of DEFAULT_PROFILE_PROVIDERS) {
        if (provider === "vellum") {
          continue;
        }
        expect(PROFILE_IMPLS[key][provider].fallbackProfile).toBeUndefined();
      }
      // A default-capable provider without a named matrix column
      // materializes from the shared BYOK templates: no pointer either.
      const entry = resolveDefaultProfileForProvider(undefined, key, {
        provider: "together",
      });
      expect(entry?.fallbackProfile).toBeUndefined();
    }
  });
});

describe("cross-provider rule", () => {
  test("every backup dispatches through a different managed upstream than its primary", () => {
    for (const key of DEFAULT_PROFILE_KEYS) {
      const primary = CODE_DEFAULT_PROFILE_ENTRIES[key];
      const backup = CODE_DEFAULT_PROFILE_ENTRIES[FALLBACK_PROFILE_BY_KEY[key]];
      const primaryUpstream = getManagedUpstream(primary.model as string);
      const backupUpstream = getManagedUpstream(backup.model as string);
      expect(primaryUpstream).not.toBeNull();
      expect(backupUpstream).not.toBeNull();
      expect(backupUpstream).not.toBe(primaryUpstream);
    }
  });

  test("the balanced experiment arms keep the cross-provider split", () => {
    const backup =
      CODE_DEFAULT_PROFILE_ENTRIES[FALLBACK_PROFILE_BY_KEY.balanced];
    const backupUpstream = getManagedUpstream(backup.model as string);
    for (const arm of ["terra", "glm-5p2"]) {
      setOverridesForTesting({ [BALANCED_MODEL_EXPERIMENT_FLAG_KEY]: arm });
      const armed = resolveDefaultProfileForProvider(
        undefined,
        "balanced",
        vellum,
      );
      expect(armed?.fallbackProfile).toBe(FALLBACK_PROFILE_BY_KEY.balanced);
      const armedUpstream = getManagedUpstream(armed?.model as string);
      expect(armedUpstream).not.toBeNull();
      expect(armedUpstream).not.toBe(backupUpstream);
    }
  });

  test("every backup model is a catalog member of its upstream (liveness-probe coverage)", () => {
    for (const key of BACKUP_PROFILE_KEYS) {
      const model = CODE_DEFAULT_PROFILE_ENTRIES[key].model as string;
      const upstream = getManagedUpstream(model);
      expect(upstream).not.toBeNull();
      expect(isModelInCatalog(upstream as string, model)).toBe(true);
    }
  });
});

describe("managed-column-only scoping", () => {
  test("the managed column materializes the backups after the primaries", () => {
    const effective = getEffectiveProfilesForProvider(undefined, vellum);
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(effective[key]).toBeDefined();
      expect(effective[key]?.provider).toBe("vellum");
      expect(effective[key]?.source).toBe("managed");
    }
    // The seeder inserts missing managed keys in MANAGED_PROFILE_TEMPLATES
    // order, which is what places backups after the primaries in
    // `profileOrder` presentation.
    expect(Object.keys(MANAGED_PROFILE_TEMPLATES)).toEqual([
      ...DEFAULT_PROFILE_KEYS,
      ...BACKUP_PROFILE_KEYS,
    ]);
  });

  test("a null defaultProvider (pre-defaultProvider install) keeps its backups", () => {
    const effective = getEffectiveProfiles(undefined);
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(effective[key]).toBeDefined();
      expect(
        resolveDefaultProfileForProvider(undefined, key, null),
      ).toBeDefined();
    }
  });

  test("a BYOK default provider materializes no backups and no pointers", () => {
    for (const provider of ["anthropic", "openai", "gemini"] as const) {
      const effective = getEffectiveProfilesForProvider(undefined, {
        provider,
      });
      for (const key of BACKUP_PROFILE_KEYS) {
        expect(effective[key]).toBeUndefined();
      }
      for (const key of DEFAULT_PROFILE_KEYS) {
        expect(effective[key]?.fallbackProfile).toBeUndefined();
      }
    }
  });

  test("the chatgpt column materializes no backups and no pointers", () => {
    const effective = getEffectiveProfilesForProvider(undefined, {
      provider: "chatgpt",
    });
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(effective[key]).toBeUndefined();
    }
    for (const key of DEFAULT_PROFILE_KEYS) {
      expect(effective[key]?.fallbackProfile).toBeUndefined();
    }
  });

  test("a persisted managed stub does not resurrect a backup off the managed column", () => {
    // A `config get` -> `config set` round-trip on a managed install can
    // leave a thin managed stub for a backup in `llm.profiles`
    // (`normalizeManagedProfileWrites`). The stub is the workspace's slot for
    // a code-owned body, not a profile, so once the column has no body behind
    // it the name must stop being listed rather than resolve to a
    // providerless entry the pickers would offer and `LLMSchema` would
    // reject.
    const workspace: Record<string, ProfileEntry> = {
      "balanced-backup": { source: "managed" },
    };
    for (const provider of ["anthropic", "chatgpt"] as const) {
      const effective = getEffectiveProfilesForProvider(workspace, {
        provider,
      });
      expect(effective["balanced-backup"]).toBeUndefined();
      expect(
        resolveDefaultProfileForProvider(workspace, "balanced-backup", {
          provider,
        }),
      ).toBeUndefined();
    }
    // The managed column still has a body for the stub to stand for.
    expect(
      getEffectiveProfilesForProvider(workspace, vellum)["balanced-backup"]
        ?.model,
    ).toBe(CODE_DEFAULT_PROFILE_ENTRIES["balanced-backup"]?.model);
  });

  test("a user-owned entry under a backup name stays listed off the managed column", () => {
    // Nothing code-owned resolves there, so the entry is simply a profile of
    // that name and keeps its own body.
    const workspace: Record<string, ProfileEntry> = {
      "balanced-backup": {
        source: "user",
        provider: "anthropic",
        model: "claude-opus-4-7",
      },
    };
    const effective = getEffectiveProfilesForProvider(workspace, {
      provider: "anthropic",
    });
    expect(effective["balanced-backup"]?.model).toBe("claude-opus-4-7");
  });
});

describe("effective-profile machinery", () => {
  test("the full effective catalog parses under LLMSchema", () => {
    // Exercises the fallbackProfile superRefine (target exists, no self
    // reference, no mix target, single hop) against the real entries.
    for (const profiles of [
      getEffectiveProfiles(undefined),
      getEffectiveProfilesForProvider(undefined, vellum),
    ]) {
      const parsed = LLMSchema.parse({
        profiles,
        activeProfile: "balanced",
      });
      for (const key of DEFAULT_PROFILE_KEYS) {
        expect(parsed.profiles[key]?.fallbackProfile).toBe(
          FALLBACK_PROFILE_BY_KEY[key],
        );
      }
    }
  });

  test("a workspace entry never overlays a backup, whatever its source", () => {
    // Backups are code-owned (`CODE_OWNED_PROFILE_NAMES`), so unlike the
    // primaries they take no workspace overlay at all: not the usual
    // label/status/topP whitelist from a managed stub, and not a user-owned
    // shadow. Disabling a backup through a hand-edited config would strand
    // the primary's fallback exactly when it is needed.
    for (const source of ["managed", "user"] as const) {
      const workspace: Record<string, ProfileEntry> = {
        "balanced-backup": {
          source,
          label: "My Backup",
          status: "disabled",
          topP: 0.7,
          // Stale content drift on disk must lose to the code default body.
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          maxTokens: 1,
        },
      };
      const entry = getEffectiveProfile(workspace, "balanced-backup");
      const body = CODE_DEFAULT_PROFILE_ENTRIES["balanced-backup"];
      expect(entry?.label).toBe(body.label);
      expect(entry?.status).toBeUndefined();
      expect(entry?.topP).toBe(body.topP);
      expect(entry?.model).toBe(body.model);
      expect(entry?.maxTokens).toBe(body.maxTokens);
      expect(String(entry?.provider)).toBe("vellum");
    }
  });

  test("backup profiles are delete-protected like the other managed defaults", () => {
    // Membership in these sets is what wires the route-level deletion
    // rejection (`rejectManagedProfileDeletion`, `handleCreateProfile`) and
    // the commitConfigWrite invariant guard
    // (`assertInvariantProfilesPreserved`).
    for (const key of BACKUP_PROFILE_KEYS) {
      expect(MANAGED_PROFILE_NAMES.has(key)).toBe(true);
      expect(INVARIANT_PROFILE_NAMES.has(key)).toBe(true);
    }
  });
});
