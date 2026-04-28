import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ANTHROPIC_PROVIDER = "anthropic";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
const MAIN_AGENT_OPUS_MODEL = "claude-opus-4-7";
const MAIN_AGENT_OPUS_MAX_TOKENS = 32000;
const QUALITY_OPTIMIZED_PROFILE = "quality-optimized";
const BALANCED_PROFILE = "balanced";
const COST_OPTIMIZED_PROFILE = "cost-optimized";

const ANTHROPIC_PROFILES: Record<string, Record<string, unknown>> = {
  [QUALITY_OPTIMIZED_PROFILE]: {
    provider: ANTHROPIC_PROVIDER,
    model: MAIN_AGENT_OPUS_MODEL,
    maxTokens: MAIN_AGENT_OPUS_MAX_TOKENS,
    effort: "max",
    thinking: { enabled: true, streamThinking: true },
  },
  [BALANCED_PROFILE]: {
    provider: ANTHROPIC_PROVIDER,
    model: ANTHROPIC_DEFAULT_MODEL,
    maxTokens: 16000,
    effort: "high",
    thinking: { enabled: true, streamThinking: true },
  },
  [COST_OPTIMIZED_PROFILE]: {
    provider: ANTHROPIC_PROVIDER,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 8192,
    effort: "low",
    thinking: { enabled: false, streamThinking: false },
  },
};

/**
 * Convert flat dot-notation key=value pairs into a nested config object.
 *
 * e.g. {"llm.default.provider": "anthropic", "llm.default.model": "claude-opus-4-6"}
 *   → {llm: {default: {provider: "anthropic", model: "claude-opus-4-6"}}}
 */
export function buildNestedConfig(
  configValues: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [dotKey, value] of Object.entries(configValues)) {
    const parts = dotKey.split(".");
    let target: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = target[part];
      if (
        existing == null ||
        typeof existing !== "object" ||
        Array.isArray(existing)
      ) {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return config;
}

/**
 * Build the first-boot workspace config overlay passed to the assistant during
 * hatch. Anthropic onboarding sets `llm.default.model` to Sonnet so background
 * fallback work stays cheaper, while the main conversation thread should remain
 * on Opus via the same call-site override seeded by workspace migration 050.
 */
export function buildInitialConfig(
  configValues: Record<string, string>,
): Record<string, unknown> {
  const config = buildNestedConfig(configValues);
  seedAnthropicInferenceProfiles(config);
  seedAnthropicMainAgentCallSite(config);
  return config;
}

/**
 * Write arbitrary key-value pairs to a temporary JSON file and return its
 * path. The caller passes this path to the daemon via the
 * VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH env var so the daemon can merge the
 * values into its workspace config on first boot.
 *
 * Keys use dot-notation to address nested fields. For example:
 *   "llm.default.provider" → {llm: {default: {provider: ...}}}
 *   "llm.default.model"    → {llm: {default: {model: ...}}}
 *
 * Returns undefined when configValues is empty (nothing to write).
 */
export function writeInitialConfig(
  configValues: Record<string, string>,
): string | undefined {
  if (Object.keys(configValues).length === 0) return undefined;

  const config = buildInitialConfig(configValues);
  const tempPath = join(
    tmpdir(),
    `vellum-default-workspace-config-${process.pid}-${Date.now()}.json`,
  );
  writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n");
  return tempPath;
}

function seedAnthropicInferenceProfiles(config: Record<string, unknown>): void {
  const llm = ensureObject(config, "llm");
  const { provider, model } = resolveInitialMainAgentBaseSelection(llm);
  if (!isDefaultAnthropicOnboardingSelection(provider, model)) return;

  const profiles = ensureObject(llm, "profiles");
  for (const [name, profile] of Object.entries(ANTHROPIC_PROFILES)) {
    if (readObject(profiles[name]) !== null) continue;
    profiles[name] = cloneObject(profile);
  }

  if (readString(llm.activeProfile) === undefined) {
    llm.activeProfile = BALANCED_PROFILE;
  }
}

function seedAnthropicMainAgentCallSite(config: Record<string, unknown>): void {
  const llm = ensureObject(config, "llm");

  const existingCallSites = readObject(llm.callSites);
  if (existingCallSites !== null && "mainAgent" in existingCallSites) return;

  const { provider, model } = resolveInitialMainAgentBaseSelection(llm);
  if (!isDefaultAnthropicOnboardingSelection(provider, model)) return;

  const callSites = ensureObject(llm, "callSites");
  const qualityProfile = readObject(
    readObject(llm.profiles)?.[QUALITY_OPTIMIZED_PROFILE],
  );

  callSites.mainAgent = isAnthropicOpusProfile(qualityProfile)
    ? { profile: QUALITY_OPTIMIZED_PROFILE }
    : {
        model: MAIN_AGENT_OPUS_MODEL,
        maxTokens: MAIN_AGENT_OPUS_MAX_TOKENS,
      };
}

function resolveInitialMainAgentBaseSelection(llm: Record<string, unknown>): {
  provider: string;
  model?: string;
} {
  const defaultBlock = readObject(llm.default);
  let provider = readString(defaultBlock?.provider) ?? ANTHROPIC_PROVIDER;
  let model = readString(defaultBlock?.model);

  const profiles = readObject(llm.profiles);
  const activeProfileName = readString(llm.activeProfile);
  const activeProfile =
    profiles !== null && activeProfileName !== undefined
      ? readObject(profiles[activeProfileName])
      : null;

  if (activeProfile !== null) {
    provider = readString(activeProfile.provider) ?? provider;
    model = readString(activeProfile.model) ?? model;
  }

  return model === undefined ? { provider } : { provider, model };
}

function isDefaultAnthropicOnboardingSelection(
  provider: string,
  model?: string,
): boolean {
  return (
    provider === ANTHROPIC_PROVIDER &&
    (model === undefined ||
      model === ANTHROPIC_DEFAULT_MODEL ||
      model === MAIN_AGENT_OPUS_MODEL)
  );
}

function isAnthropicOpusProfile(
  profile: Record<string, unknown> | null,
): boolean {
  if (profile === null) return false;

  const provider = readString(profile.provider);
  const model = readString(profile.model);
  return (
    (provider === undefined || provider === ANTHROPIC_PROVIDER) &&
    model === MAIN_AGENT_OPUS_MODEL
  );
}

function cloneObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function ensureObject(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = parent[key];
  if (
    existing != null &&
    typeof existing === "object" &&
    !Array.isArray(existing)
  ) {
    return existing as Record<string, unknown>;
  }

  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
