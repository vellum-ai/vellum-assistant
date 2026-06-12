import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { safeStringSlice } from "../util/unicode.js";

const MAX_METADATA_VALUE_LENGTH = 128;

export type UsageAttributionProfileSource =
  | "call_site"
  | "conversation"
  | "active"
  | "default"
  | "unknown";

export interface UsageAttributionInput {
  callSite: LLMCallSite | null;
  overrideProfile?: string | null;
  /**
   * Mirrors `ResolveCallSiteOpts.forceOverrideProfile`: the override profile
   * was floated above the call-site layers for this request, so attribution
   * must credit it ahead of the call-site profile too.
   */
  forceOverrideProfile?: boolean;
  /**
   * Per-conversation seed for `mix`-profile expansion (the conversation id).
   * When the applied profile is a mix, threading the same seed the dispatch
   * path uses ensures `resolvedModel`/`resolvedMixArm` reflect the arm the
   * request actually ran on. Omitted by one-shot callers (the snapshot's
   * `resolvedMixArm` is then null even if a mix was involved).
   */
  selectionSeed?: string;
}

export interface UsageAttributionSnapshot {
  callSite: LLMCallSite | null;
  activeProfile: string | null;
  overrideProfile: string | null;
  callSiteProfile: string | null;
  appliedProfile: string | null;
  profileSource: UsageAttributionProfileSource;
  resolvedProvider: string;
  resolvedModel: string;
  /**
   * When `appliedProfile` is a mix profile, the constituent arm chosen for
   * this request; null otherwise. Lets A/B analysis attribute usage to the
   * specific arm (mix name lives in `appliedProfile`).
   */
  resolvedMixArm: string | null;
}

/**
 * The four nullable attribution columns shared by telemetry event rows
 * (`tool_invocations`, `skill_loaded_events`).
 */
export interface UsageAttributionColumns {
  provider: string | null;
  model: string | null;
  inferenceProfile: string | null;
  inferenceProfileSource: string | null;
}

/**
 * Maps an attribution snapshot to the shared telemetry columns — the same
 * mapping `llm_usage` reporting uses (`appliedProfile` → inference_profile,
 * `profileSource` → inference_profile_source). Accepts a missing snapshot so
 * producers that resolve attribution best-effort can pass it through as-is.
 */
export function toAttributionColumns(
  snapshot: UsageAttributionSnapshot | null | undefined,
): UsageAttributionColumns {
  return {
    provider: snapshot?.resolvedProvider ?? null,
    model: snapshot?.resolvedModel ?? null,
    inferenceProfile: snapshot?.appliedProfile ?? null,
    inferenceProfileSource: snapshot?.profileSource ?? null,
  };
}

/**
 * Sanitizes values before they are copied into external metadata surfaces.
 * Empty strings and control-character-bearing strings are dropped, and long
 * values are capped so later forwarding cannot create unbounded headers.
 */
export function sanitizeUsageMetadataValue(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (containsControlCharacter(trimmed)) return null;

  return safeStringSlice(trimmed, 0, MAX_METADATA_VALUE_LENGTH);
}

export function resolveUsageAttribution(
  input: UsageAttributionInput,
): UsageAttributionSnapshot {
  const llm = getConfig().llm;
  const callSite = input.callSite;
  const overrideProfile = normalizeProfileId(input.overrideProfile);

  if (callSite == null) {
    const resolvedMainAgent = resolveCallSiteConfig("mainAgent", llm, {
      ...(input.selectionSeed != null
        ? { selectionSeed: input.selectionSeed }
        : {}),
    });
    return {
      callSite: null,
      activeProfile: normalizeProfileId(llm.activeProfile),
      overrideProfile,
      callSiteProfile: null,
      appliedProfile: null,
      profileSource: "unknown",
      resolvedProvider: resolvedMainAgent.provider,
      resolvedModel: resolvedMainAgent.model,
      resolvedMixArm: null,
    };
  }

  // Capture which arm each expanded mix resolved to so we can attribute usage
  // to the arm behind the applied (mix) profile below.
  const mixSelections = new Map<string, string>();
  const resolved = resolveCallSiteConfig(callSite, llm, {
    ...(overrideProfile != null ? { overrideProfile } : {}),
    ...(input.forceOverrideProfile === true
      ? { forceOverrideProfile: true }
      : {}),
    ...(input.selectionSeed != null
      ? { selectionSeed: input.selectionSeed }
      : {}),
    onMixSelected: ({ mixProfile, chosenProfile }) =>
      mixSelections.set(mixProfile, chosenProfile),
  });
  const activeProfile = normalizeProfileId(llm.activeProfile);
  const callSiteProfile = normalizeProfileId(
    llm.callSites?.[callSite]?.profile,
  );
  const profile = resolveAppliedProfile({
    callSite,
    profiles: llm.profiles ?? {},
    activeProfile,
    overrideProfile,
    forceOverrideProfile: input.forceOverrideProfile === true,
    callSiteProfile,
  });

  return {
    callSite,
    activeProfile,
    overrideProfile,
    callSiteProfile,
    appliedProfile: profile.appliedProfile,
    profileSource: profile.profileSource,
    resolvedProvider: resolved.provider,
    resolvedModel: resolved.model,
    resolvedMixArm:
      profile.appliedProfile != null
        ? (mixSelections.get(profile.appliedProfile) ?? null)
        : null,
  };
}

function resolveAppliedProfile(input: {
  callSite: LLMCallSite;
  profiles: Record<string, unknown>;
  activeProfile: string | null;
  overrideProfile: string | null;
  forceOverrideProfile: boolean;
  callSiteProfile: string | null;
}): Pick<UsageAttributionSnapshot, "appliedProfile" | "profileSource"> {
  if (input.callSite === "mainAgent") {
    if (
      input.overrideProfile != null &&
      input.profiles[input.overrideProfile] != null
    ) {
      return {
        appliedProfile: input.overrideProfile,
        profileSource: "conversation",
      };
    }

    if (
      input.activeProfile != null &&
      input.profiles[input.activeProfile] != null
    ) {
      return {
        appliedProfile: input.activeProfile,
        profileSource: "active",
      };
    }

    if (
      input.callSiteProfile != null &&
      input.profiles[input.callSiteProfile] != null
    ) {
      return {
        appliedProfile: input.callSiteProfile,
        profileSource: "call_site",
      };
    }

    return {
      appliedProfile: null,
      profileSource: "default",
    };
  }

  // Forced override floats above the call-site profile (the resolver's
  // `forceOverrideProfile` escape hatch), so it wins attribution too.
  if (
    input.forceOverrideProfile &&
    input.overrideProfile != null &&
    input.profiles[input.overrideProfile] != null
  ) {
    return {
      appliedProfile: input.overrideProfile,
      profileSource: "conversation",
    };
  }

  if (
    input.callSiteProfile != null &&
    input.profiles[input.callSiteProfile] != null
  ) {
    return {
      appliedProfile: input.callSiteProfile,
      profileSource: "call_site",
    };
  }

  if (
    input.overrideProfile != null &&
    input.profiles[input.overrideProfile] != null
  ) {
    return {
      appliedProfile: input.overrideProfile,
      profileSource: "conversation",
    };
  }

  if (
    input.activeProfile != null &&
    input.profiles[input.activeProfile] != null
  ) {
    return {
      appliedProfile: input.activeProfile,
      profileSource: "active",
    };
  }

  return {
    appliedProfile: null,
    profileSource: "default",
  };
}

function normalizeProfileId(value: string | null | undefined): string | null {
  return value ?? null;
}

function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}
