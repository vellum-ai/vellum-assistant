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
    return {
      callSite: null,
      activeProfile: normalizeProfileId(llm.activeProfile),
      overrideProfile,
      callSiteProfile: null,
      appliedProfile: null,
      profileSource: "unknown",
      resolvedProvider: llm.default.provider,
      resolvedModel: llm.default.model,
    };
  }

  const resolved = resolveCallSiteConfig(callSite, llm, {
    ...(overrideProfile != null ? { overrideProfile } : {}),
  });
  const activeProfile = normalizeProfileId(llm.activeProfile);
  const callSiteProfile = normalizeProfileId(llm.callSites?.[callSite]?.profile);
  const profile = resolveAppliedProfile({
    profiles: llm.profiles ?? {},
    activeProfile,
    overrideProfile,
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
  };
}

function resolveAppliedProfile(input: {
  profiles: Record<string, unknown>;
  activeProfile: string | null;
  overrideProfile: string | null;
  callSiteProfile: string | null;
}): Pick<UsageAttributionSnapshot, "appliedProfile" | "profileSource"> {
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
