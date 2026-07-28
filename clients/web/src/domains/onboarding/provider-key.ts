import {
  configLlmProfilesByNamePut,
  configPatch,
  inferenceProviderconnectionsPost,
  secretsPost,
} from "@/generated/daemon/sdk.gen";
import {
  defaultModelForOnboardingProvider,
  onboardingProvider,
  type OnboardingProviderId,
} from "@/domains/onboarding/provider-catalog";
import type { ProfileEntry } from "@/generated/daemon/types.gen";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application, then
// written to the freshly hatched assistant. Mirrors the macOS flow, which
// holds the key in-memory and POSTs it to the daemon once the assistant is up.

const PENDING_KEY_STORAGE = "onboarding.providerKey";
const ONBOARDING_ACTIVE_PROFILE = "custom-balanced";
const DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS = 200_000;

export interface PendingProviderKey {
  provider: OnboardingProviderId;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
  /** Selected model for the initial local assistant profile. */
  model?: string;
  /** Base URL for openai-compatible providers. */
  baseUrl?: string;
  /** Comma-separated model identifiers for openai-compatible providers. */
  customModels?: string;
}

export function setPendingProviderKey(value: PendingProviderKey | null): void {
  try {
    if (value === null) {
      sessionStorage.removeItem(PENDING_KEY_STORAGE);
      return;
    }
    sessionStorage.setItem(PENDING_KEY_STORAGE, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode / quota) — degrade silently.
  }
}

function isPendingProviderKey(value: unknown): value is PendingProviderKey {
  return (
    value !== null &&
    typeof value === "object" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "key" in value &&
    typeof value.key === "string" &&
    (!("model" in value) || typeof value.model === "string") &&
    (!("baseUrl" in value) || typeof value.baseUrl === "string") &&
    (!("customModels" in value) || typeof value.customModels === "string")
  );
}

export function peekPendingProviderKey(): PendingProviderKey | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY_STORAGE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingProviderKey(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function consumePendingProviderKey(): PendingProviderKey | null {
  const value = peekPendingProviderKey();
  try {
    sessionStorage.removeItem(PENDING_KEY_STORAGE);
  } catch {
    // ignore
  }
  return value;
}

// Daemon wrappers via the generated SDK. Duplicated minimally here because
// cross-domain imports are ESLint-gated in clients/web.

async function writeApiKeySecret(
  assistantId: string,
  provider: OnboardingProviderId,
  value: string,
): Promise<void> {
  const { response } = await secretsPost({
    path: { assistant_id: assistantId },
    body: { type: "api_key", name: provider, value },
    throwOnError: false,
  });
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to write provider secret"), {
      status: response?.status,
    });
  }
}

async function createProviderConnection(
  assistantId: string,
  provider: OnboardingProviderId,
  hasKey: boolean,
  options?: { baseUrl?: string; customModels?: string },
): Promise<void> {
  const isOpenAICompatible = provider === "openai-compatible";
  const useApiKeyAuth = hasKey || isOpenAICompatible;
  const auth = useApiKeyAuth
    ? { type: "api_key" as const, credential: `credential/${provider}/api_key` }
    : { type: "none" as const };

  const baseUrl = isOpenAICompatible && options?.baseUrl
    ? options.baseUrl
    : undefined;
  const models = isOpenAICompatible && options?.customModels
    ? options.customModels
        .split(",")
        .map((id) => ({ id: id.trim() }))
        .filter((m) => m.id)
    : undefined;

  const { response } = await inferenceProviderconnectionsPost({
    path: { assistant_id: assistantId },
    body: {
      name: provider,
      provider,
      auth,
      ...(baseUrl !== undefined ? { base_url: baseUrl } : {}),
      ...(models !== undefined ? { models } : {}),
    },
    throwOnError: false,
  });
  if (!response?.ok && response?.status !== 409) {
    throw Object.assign(new Error("Failed to create provider connection"), {
      status: response?.status,
    });
  }
}

function buildOnboardingProfile(
  provider: OnboardingProviderId,
  model: string,
): ProfileEntry {
  const providerEntry = onboardingProvider(provider);
  const modelEntry = providerEntry?.models?.find((entry) => entry.id === model);
  const profile: ProfileEntry = {
    provider,
    model,
    provider_connection: provider,
    source: "user",
    label: "Balanced",
    description: "Good balance of quality, cost, and speed",
    maxTokens: modelEntry?.maxOutputTokens ?? 16_000,
    contextWindow: {
      maxInputTokens:
        modelEntry?.contextWindowTokens ??
        DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS,
    },
  };

  if (provider === "ollama") {
    profile.effort = "none";
    profile.thinking = { enabled: false, streamThinking: false };
  } else {
    profile.effort = "high";
    profile.thinking = { enabled: true, streamThinking: true };
  }

  return profile;
}

async function replaceOnboardingProfile(
  assistantId: string,
  provider: OnboardingProviderId,
  model: string,
): Promise<void> {
  const { response } = await configLlmProfilesByNamePut({
    path: { assistant_id: assistantId, name: ONBOARDING_ACTIVE_PROFILE },
    body: buildOnboardingProfile(provider, model),
    throwOnError: false,
  });
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to set provider profile"), {
      status: response?.status,
    });
  }
}

async function activateOnboardingProfile(assistantId: string): Promise<void> {
  const { response } = await configPatch({
    path: { assistant_id: assistantId },
    body: { llm: { activeProfile: ONBOARDING_ACTIVE_PROFILE } },
    throwOnError: false,
  });
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to activate provider profile"), {
      status: response?.status,
    });
  }
}

/**
 * Apply the model-provider selection collected during onboarding to the
 * freshly hatched local assistant. Consumes the pending key; no-op when nothing
 * was collected (e.g. Vellum Cloud, which skips the API-key step).
 */
export async function applyPendingProviderKey(
  assistantId: string,
): Promise<void> {
  const pending = consumePendingProviderKey();
  if (!pending) return;
  const trimmed = pending.key.trim();
  const hasKey = trimmed.length > 0;
  const isOpenAICompatible = pending.provider === "openai-compatible";
  if (hasKey || isOpenAICompatible) {
    await writeApiKeySecret(assistantId, pending.provider, trimmed);
  }
  await createProviderConnection(assistantId, pending.provider, hasKey, {
    baseUrl: pending.baseUrl,
    customModels: pending.customModels,
  });
  const selectedModel = pending.model?.trim();
  const firstCustomModel = pending.customModels
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => s);
  const model =
    selectedModel || firstCustomModel || defaultModelForOnboardingProvider(pending.provider);
  if (model) {
    await replaceOnboardingProfile(assistantId, pending.provider, model);
    await activateOnboardingProfile(assistantId);
  }
}
