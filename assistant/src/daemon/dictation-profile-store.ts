/**
 * Persistent store for dictation profiles.
 *
 * Persisted to ~/.vellum/dictation-profiles.json using the
 * atomic-write pattern (write .tmp → rename → chmod).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";

const log = getLogger("dictation-profile-store");

// --- Validation limits ---

const MAX_PROFILES = 50;
const MAX_DICTIONARY_ENTRIES = 500;
const MAX_SNIPPETS = 200;
const MAX_STYLE_PROMPT_LENGTH = 2000;
const MAX_TRIGGER_LENGTH = 200;
const MAX_EXPANSION_LENGTH = 5000;
const MAX_SPOKEN_LENGTH = 200;
const MAX_WRITTEN_LENGTH = 200;

// --- Interfaces ---

export interface DictationDictionaryEntry {
  spoken: string;
  written: string;
  caseSensitive?: boolean; // default false
  wholeWord?: boolean; // default true
}

export interface DictationSnippet {
  trigger: string;
  expansion: string;
  enabled?: boolean; // default true
}

export interface DictationAppMapping {
  profileId: string;
  bundleIdentifier?: string;
  appName?: string;
}

export interface DictationProfile {
  id: string;
  name: string;
  enabled?: boolean; // default true
  stylePrompt?: string;
  dictionary?: DictationDictionaryEntry[];
  snippets?: DictationSnippet[];
}

export interface DictationProfilesConfig {
  version: 1;
  defaultProfileId?: string;
  appMappings?: DictationAppMapping[];
  profiles: DictationProfile[];
}

export interface ProfileResolution {
  profile: DictationProfile;
  source: "request" | "app_mapping" | "default" | "fallback";
}

// --- Built-in fallback ---

const BUILTIN_GENERAL_PROFILE: DictationProfile = {
  id: "general",
  name: "General",
  enabled: true,
  stylePrompt: "",
  dictionary: [],
  snippets: [],
};

function getDefaultConfig(): DictationProfilesConfig {
  return {
    version: 1,
    profiles: [{ ...BUILTIN_GENERAL_PROFILE }],
  };
}

// --- File I/O ---

let storePathOverride: string | null = null;

function getStorePath(): string {
  if (storePathOverride) return storePathOverride;
  return join(getWorkspaceDir(), "dictation-profiles.json");
}

let cachedConfig: DictationProfilesConfig | null = null;

function validateAndClampConfig(raw: unknown): DictationProfilesConfig {
  if (typeof raw !== "object" || raw == null) {
    log.warn("Invalid dictation-profiles.json: not an object, using defaults");
    return getDefaultConfig();
  }

  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.profiles)) {
    log.warn("Invalid dictation-profiles.json format, using defaults");
    return getDefaultConfig();
  }

  // Clamp profiles
  const profiles = (obj.profiles as unknown[]).slice(0, MAX_PROFILES);
  const validProfiles: DictationProfile[] = [];

  for (const p of profiles) {
    if (typeof p !== "object" || p == null) continue;
    const profile = p as Record<string, unknown>;
    if (typeof profile.id !== "string" || typeof profile.name !== "string")
      continue;

    // Clamp stylePrompt
    let stylePrompt =
      typeof profile.stylePrompt === "string" ? profile.stylePrompt : "";
    if (stylePrompt.length > MAX_STYLE_PROMPT_LENGTH) {
      log.warn(
        { profileId: profile.id },
        `stylePrompt exceeds ${MAX_STYLE_PROMPT_LENGTH} chars, truncating`,
      );
      stylePrompt = stylePrompt.slice(0, MAX_STYLE_PROMPT_LENGTH);
    }

    // Validate dictionary entries
    const rawDict = Array.isArray(profile.dictionary) ? profile.dictionary : [];
    const dictionary: DictationDictionaryEntry[] = [];
    for (const entry of rawDict.slice(0, MAX_DICTIONARY_ENTRIES)) {
      if (typeof entry !== "object" || entry == null) continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.spoken !== "string" || typeof e.written !== "string")
        continue;
      if (
        e.spoken.length > MAX_SPOKEN_LENGTH ||
        e.written.length > MAX_WRITTEN_LENGTH
      ) {
        log.warn(
          { profileId: profile.id },
          "Skipping dictionary entry exceeding length limits",
        );
        continue;
      }
      dictionary.push({
        spoken: e.spoken,
        written: e.written,
        caseSensitive:
          typeof e.caseSensitive === "boolean" ? e.caseSensitive : undefined,
        wholeWord: typeof e.wholeWord === "boolean" ? e.wholeWord : undefined,
      });
    }

    // Validate snippets
    const rawSnippets = Array.isArray(profile.snippets) ? profile.snippets : [];
    const snippets: DictationSnippet[] = [];
    for (const s of rawSnippets.slice(0, MAX_SNIPPETS)) {
      if (typeof s !== "object" || s == null) continue;
      const snip = s as Record<string, unknown>;
      if (
        typeof snip.trigger !== "string" ||
        typeof snip.expansion !== "string"
      )
        continue;
      if (
        snip.trigger.length > MAX_TRIGGER_LENGTH ||
        snip.expansion.length > MAX_EXPANSION_LENGTH
      ) {
        log.warn(
          { profileId: profile.id },
          "Skipping snippet exceeding length limits",
        );
        continue;
      }
      snippets.push({
        trigger: snip.trigger,
        expansion: snip.expansion,
        enabled: typeof snip.enabled === "boolean" ? snip.enabled : undefined,
      });
    }

    validProfiles.push({
      id: profile.id as string,
      name: profile.name as string,
      enabled:
        typeof profile.enabled === "boolean" ? profile.enabled : undefined,
      stylePrompt,
      dictionary,
      snippets,
    });
  }

  // Validate app mappings
  const rawMappings = Array.isArray(obj.appMappings) ? obj.appMappings : [];
  const appMappings: DictationAppMapping[] = [];
  for (const m of rawMappings) {
    if (typeof m !== "object" || m == null) continue;
    const mapping = m as Record<string, unknown>;
    if (typeof mapping.profileId !== "string") continue;
    if (
      typeof mapping.bundleIdentifier !== "string" &&
      typeof mapping.appName !== "string"
    )
      continue;
    appMappings.push({
      profileId: mapping.profileId,
      bundleIdentifier:
        typeof mapping.bundleIdentifier === "string"
          ? mapping.bundleIdentifier
          : undefined,
      appName:
        typeof mapping.appName === "string" ? mapping.appName : undefined,
    });
  }

  return {
    version: 1,
    defaultProfileId:
      typeof obj.defaultProfileId === "string"
        ? obj.defaultProfileId
        : undefined,
    appMappings: appMappings.length > 0 ? appMappings : undefined,
    profiles: validProfiles,
  };
}

function loadFromDisk(): DictationProfilesConfig {
  const path = getStorePath();
  if (!existsSync(path)) {
    return getDefaultConfig();
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    return validateAndClampConfig(data);
  } catch (err) {
    log.error({ err }, "Failed to load dictation-profiles.json");
    return getDefaultConfig();
  }
}

// --- Public API ---

export function loadConfig(): DictationProfilesConfig {
  if (cachedConfig == null) {
    cachedConfig = loadFromDisk();
  }
  return cachedConfig;
}

function isProfileEnabled(profile: DictationProfile): boolean {
  return profile.enabled !== false;
}

/**
 * Resolve which profile to use for a given dictation request.
 *
 * Precedence: requestProfileId → app mapping → defaultProfileId → built-in fallback.
 */
export function resolveProfile(
  bundleId: string,
  appName: string,
  requestProfileId?: string,
): ProfileResolution {
  const config = loadConfig();

  const enabledProfiles = config.profiles.filter(isProfileEnabled);
  const profileById = (id: string) => enabledProfiles.find((p) => p.id === id);

  // 1. Explicit request profile
  if (requestProfileId) {
    const profile = profileById(requestProfileId);
    if (profile) {
      return { profile, source: "request" };
    }
    log.warn({ requestProfileId }, "Requested profile not found or disabled");
  }

  // 2. App mapping (bundleIdentifier match beats appName match)
  if (config.appMappings && config.appMappings.length > 0) {
    let bundleMatch: DictationAppMapping | undefined;
    let appNameMatch: DictationAppMapping | undefined;

    for (const mapping of config.appMappings) {
      if (
        !bundleMatch &&
        mapping.bundleIdentifier &&
        mapping.bundleIdentifier === bundleId
      ) {
        bundleMatch = mapping;
      }
      if (!appNameMatch && mapping.appName && mapping.appName === appName) {
        appNameMatch = mapping;
      }
    }

    const bestMapping = bundleMatch ?? appNameMatch;
    if (bestMapping) {
      const profile = profileById(bestMapping.profileId);
      if (profile) {
        return { profile, source: "app_mapping" };
      }
    }
  }

  // 3. Default profile
  if (config.defaultProfileId) {
    const profile = profileById(config.defaultProfileId);
    if (profile) {
      return { profile, source: "default" };
    }
  }

  // 4. Built-in fallback
  return { profile: BUILTIN_GENERAL_PROFILE, source: "fallback" };
}

/** Reset the in-memory cache (for testing). */
export function resetCache(): void {
  cachedConfig = null;
}

/** Override the store file path (for testing). Pass null to reset. */
export function setStorePathOverride(path: string | null): void {
  storePathOverride = path;
  cachedConfig = null;
}
