import type { LlmCatalogModel } from "@/assistant/llm-model-catalog";
import {
  WEB_SEARCH_PROVIDER_KEY_STORAGE,
} from "@/assistant/generated/web-search-provider-catalog.gen";

import type {
  CallSiteOverrideDraft,
  DaemonConfig,
  DaemonConfigPatch,
  InferenceTokenBudgetState,
  ProfileEntry,
  ProfileWithName,
} from "@/domains/settings/ai/ai-types";
import { TOKEN_SLIDER_MIN_TOKENS } from "@/domains/settings/ai/ai-types";

/**
 * Merges `profileOrder` with `profiles` to produce a stable ordered list.
 *
 * Entries appear in `profileOrder` sequence first, followed by any extras
 * present in `profiles` but missing from `profileOrder` (e.g. newly seeded
 * profiles that haven't been reordered yet).
 */
export function buildOrderedProfiles(
  profiles: Record<string, ProfileEntry>,
  profileOrder: string[],
): ProfileWithName[] {
  const ordered = profileOrder
    .filter((name) => name in profiles)
    .map((name) => ({ name, ...profiles[name]! }));
  const inOrder = new Set(profileOrder);
  const extras = Object.entries(profiles)
    .filter(([name]) => !inOrder.has(name))
    .map(([name, entry]) => ({ name, ...entry }));
  return [...ordered, ...extras];
}

export function assertProvisionSuccess(result: unknown): void {
  if (
    result &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false
  ) {
    throw new Error("Failed to provision API key: server returned success=false");
  }
}

export function clampTokenBudget(
  value: number,
  max: number,
  min = TOKEN_SLIDER_MIN_TOKENS,
): number {
  if (!Number.isFinite(value)) {
    return Math.min(min, max);
  }
  return Math.min(Math.max(Math.round(value), min), max);
}

function formatCompactNumber(value: number, fractionDigits: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
}

export function formatCompactTokens(value: number | number[]): string {
  const numericValue = Array.isArray(value) ? (value[0] ?? 0) : value;
  const roundedValue = Math.round(numericValue);
  if (Math.abs(roundedValue) >= 1_000_000) {
    return `${formatCompactNumber(roundedValue / 1_000_000, 2)}M`;
  }
  if (Math.abs(roundedValue) >= 1_000) {
    return `${formatCompactNumber(roundedValue / 1_000, 1)}K`;
  }
  return roundedValue.toLocaleString("en-US");
}

export function resolveTokenBudgetStateForModel(
  model: LlmCatalogModel,
  state: InferenceTokenBudgetState,
): InferenceTokenBudgetState {
  const contextBudget = state.contextWindowTouched
    ? state.contextWindowTokens
    : model.defaultContextWindowTokens;
  const maxOutputBudget = state.maxOutputTouched
    ? state.maxOutputTokens
    : model.maxOutputTokens;

  return {
    maxOutputTokens: clampTokenBudget(
      maxOutputBudget,
      model.maxOutputTokens,
    ),
    maxOutputTouched: state.maxOutputTouched,
    contextWindowTokens: clampTokenBudget(
      contextBudget,
      model.contextWindowTokens,
    ),
    contextWindowTouched: state.contextWindowTouched,
  };
}

export function getLongContextPricingHint(
  model: LlmCatalogModel,
  contextWindowTokens: number,
): string | null {
  const threshold = model.longContextPricingThresholdTokens;
  if (threshold === undefined || contextWindowTokens <= threshold) {
    return null;
  }
  return `Budgets above ${formatCompactTokens(threshold)} may use long-context pricing for ${model.displayName}.`;
}

/**
 * Returns the localStorage key for a web-search provider's user-supplied
 * API key, or "" for managed providers that don't store a user-supplied key.
 */
export function getWebSearchProviderKeyStorage(provider: string): string {
  return WEB_SEARCH_PROVIDER_KEY_STORAGE[provider] ?? "";
}

/**
 * Snapshots only the fields in `config` that `patch` will touch, so
 * `onError` can roll back just those fields without clobbering concurrent
 * mutations' optimistic updates.
 *
 * Returns a `DaemonConfigPatch`-shaped object containing the previous values
 * for every key present in the patch. Feed it back to `applyConfigPatch` in
 * the rollback updater to restore exactly what was changed.
 */
export function snapshotPatchedFields(config: DaemonConfig, patch: DaemonConfigPatch): DaemonConfigPatch {
  const snapshot: DaemonConfigPatch = {};

  if ("memory" in patch) {
    snapshot.memory = config.memory ? structuredClone(config.memory) : null;
  }

  if (patch.services) {
    const services: NonNullable<DaemonConfigPatch["services"]> = {};
    if ("web-search" in patch.services) {
      services["web-search"] = config.services?.["web-search"]
        ? { ...config.services["web-search"] }
        : null;
    }
    if ("image-generation" in patch.services) {
      services["image-generation"] = config.services?.["image-generation"]
        ? { ...config.services["image-generation"] }
        : null;
    }
    snapshot.services = services;
  }

  if (patch.llm) {
    const llm: NonNullable<DaemonConfigPatch["llm"]> = {};

    if ("activeProfile" in patch.llm) {
      llm.activeProfile = config.llm?.activeProfile ?? null;
    }
    if ("profileOrder" in patch.llm) {
      llm.profileOrder = config.llm?.profileOrder ? [...config.llm.profileOrder] : [];
    }
    if ("default" in patch.llm) {
      llm.default = config.llm?.default ? { ...config.llm.default } : null;
    }

    if (patch.llm.profiles) {
      const profiles: Record<string, Partial<ProfileEntry> | null> = {};
      for (const name of Object.keys(patch.llm.profiles)) {
        const existing = config.llm?.profiles?.[name];
        profiles[name] = existing ? { ...existing } : null;
      }
      llm.profiles = profiles;
    }

    if (patch.llm.callSites) {
      const callSites: Record<string, CallSiteOverrideDraft | null> = {};
      for (const id of Object.keys(patch.llm.callSites)) {
        const existing = config.llm?.callSites?.[id];
        callSites[id] = existing ? { ...existing } : null;
      }
      llm.callSites = callSites;
    }

    snapshot.llm = llm;
  }

  return snapshot;
}

/**
 * Applies a `DaemonConfigPatch` to a cached `DaemonConfig`, mimicking the
 * daemon's deep-merge semantics: omitted keys are left unchanged, explicit
 * `null` at record-entry positions deletes the entry.
 *
 * Used by the mutation hook's `onMutate` callback to optimistically update
 * the TanStack Query cache before the server responds, and by `onError` to
 * roll back only the fields that were changed (via a snapshot from
 * `snapshotPatchedFields`).
 */
export function applyConfigPatch(config: DaemonConfig, patch: DaemonConfigPatch): DaemonConfig {
  const result: DaemonConfig = { ...config };

  if ("memory" in patch) {
    if (patch.memory === null) {
      delete result.memory;
    } else if (patch.memory) {
      result.memory = { ...result.memory, ...patch.memory };
    }
  }

  if (patch.services) {
    const services: NonNullable<DaemonConfig["services"]> = { ...result.services };
    if ("web-search" in patch.services) {
      const ws = patch.services["web-search"];
      if (ws === null) {
        delete services["web-search"];
      } else if (ws) {
        services["web-search"] = { ...services["web-search"], ...ws };
      }
    }
    if ("image-generation" in patch.services) {
      const ig = patch.services["image-generation"];
      if (ig === null) {
        delete services["image-generation"];
      } else if (ig) {
        services["image-generation"] = { ...services["image-generation"], ...ig };
      }
    }
    result.services = services;
  }

  if (patch.llm) {
    const llm: NonNullable<DaemonConfig["llm"]> = { ...result.llm };

    if ("activeProfile" in patch.llm) {
      llm.activeProfile = patch.llm.activeProfile ?? undefined;
    }
    if ("profileOrder" in patch.llm) {
      llm.profileOrder = patch.llm.profileOrder;
    }
    if ("default" in patch.llm) {
      if (patch.llm.default === null) {
        delete llm.default;
      } else if (patch.llm.default) {
        llm.default = { ...llm.default, ...patch.llm.default };
      }
    }

    if (patch.llm.profiles) {
      const profiles: Record<string, ProfileEntry> = { ...llm.profiles };
      for (const [name, entry] of Object.entries(patch.llm.profiles)) {
        if (entry === null) {
          delete profiles[name];
        } else {
          profiles[name] = { ...profiles[name], ...entry };
        }
      }
      llm.profiles = profiles;
    }

    if (patch.llm.callSites) {
      const callSites: NonNullable<DaemonConfig["llm"]>["callSites"] = { ...llm.callSites };
      for (const [id, entry] of Object.entries(patch.llm.callSites)) {
        if (entry === null) {
          callSites[id] = null;
        } else {
          const existing = callSites[id];
          callSites[id] = { ...(existing ?? {}), ...entry };
        }
      }
      llm.callSites = callSites;
    }

    result.llm = llm;
  }

  return result;
}
