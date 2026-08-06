import {
  configLlmDefaultproviderPut,
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
import { supportsOnboardingDefaultProvider } from "@/lib/backwards-compat/onboarding-default-provider";
import type {
  ConfigLlmDefaultproviderPutData,
  ProfileEntry,
} from "@/generated/daemon/types.gen";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application, then
// written to the freshly hatched assistant. Mirrors the macOS flow, which
// holds the key in-memory and POSTs it to the daemon once the assistant is up.

const PENDING_KEY_STORAGE = "onboarding.providerKey";
const DEFAULT_CONTEXT_WINDOW_MAX_INPUT_TOKENS = 200_000;
const LEGACY_ONBOARDING_ACTIVE_PROFILE = "custom-balanced";

/**
 * Providers the daemon's code-defined default profiles cannot serve: Ollama is
 * keyless/local and openai-compatible needs a user-supplied base URL + model
 * list, so neither has a column in the intent × provider matrix. Onboarding
 * authors and activates a user profile for these; every other catalog provider
 * relies on the read-only defaults resolved through `llm.defaultProvider`.
 */
const PROFILE_AUTHORING_PROVIDERS = new Set<OnboardingProviderId>([
  "ollama",
  "openai-compatible",
]);

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
    if (!raw) {
      return null;
    }
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

/**
 * The daemon validated the entered API key against the provider and the
 * provider rejected it (e.g. a 401 on a typo'd key). A user-correctable input
 * error, not a transport failure: callers surface it with a path back to the
 * API-key screen instead of logging and moving on.
 */
export class ProviderKeyRejectedError extends Error {
  readonly provider: OnboardingProviderId;
  readonly reason?: string;

  constructor(provider: OnboardingProviderId, reason?: string) {
    super(reason ?? `${provider} rejected the API key`);
    this.name = "ProviderKeyRejectedError";
    this.provider = provider;
    this.reason = reason;
  }
}

// Daemon wrappers via the generated SDK. Duplicated minimally here because
// cross-domain imports are ESLint-gated in clients/web.

function ensureOk(
  response: { ok: boolean; status: number } | undefined,
  message: string,
): void {
  if (!response?.ok) {
    throw Object.assign(new Error(message), { status: response?.status });
  }
}

async function writeApiKeySecret(
  assistantId: string,
  provider: OnboardingProviderId,
  value: string,
): Promise<void> {
  const { data, response } = await secretsPost({
    path: { assistant_id: assistantId },
    body: { type: "api_key", name: provider, value },
    throwOnError: false,
  });
  ensureOk(response, "Failed to write provider secret");
  // The daemon reports a provider-rejected key as a 200 with success:false.
  // The key was NOT stored, so continuing would point the assistant's config
  // at a credential that doesn't exist.
  if (data && data.success === false) {
    throw new ProviderKeyRejectedError(provider, data.error);
  }
}

/**
 * Create the `<provider>-personal` connection the BYOK columns of the intent ×
 * provider matrix stamp onto the default profiles — the same connection a
 * CLI hatch's seeding creates when the hatch overlay carries the provider.
 */
async function createPersonalConnection(
  assistantId: string,
  provider: OnboardingProviderId,
): Promise<void> {
  const displayName = onboardingProvider(provider)?.displayName ?? provider;
  const { response } = await inferenceProviderconnectionsPost({
    path: { assistant_id: assistantId },
    body: {
      name: `${provider}-personal`,
      provider,
      auth: {
        type: "api_key",
        credential: `credential/${provider}/api_key`,
      },
      label: `${displayName} (Personal)`,
    },
    throwOnError: false,
  });
  if (response?.status !== 409) {
    ensureOk(response, "Failed to create provider connection");
  }
}

async function setDefaultProvider(
  assistantId: string,
  provider: OnboardingProviderId,
): Promise<void> {
  const { response } = await configLlmDefaultproviderPut({
    path: { assistant_id: assistantId },
    body: {
      // The generated enum tracks the daemon's default-profile matrix, which
      // can lag the onboarding catalog within a release; the daemon strict-
      // validates, so an unsupported provider fails loudly rather than
      // silently.
      provider: provider as ConfigLlmDefaultproviderPutData["body"]["provider"],
    },
    throwOnError: false,
  });
  ensureOk(response, "Failed to set default provider");
}

async function createCustomProviderConnection(
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

  const baseUrl =
    isOpenAICompatible && options?.baseUrl ? options.baseUrl : undefined;
  const models =
    isOpenAICompatible && options?.customModels
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
  if (response?.status !== 409) {
    ensureOk(response, "Failed to create provider connection");
  }
}

function buildCustomProviderProfile(
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
    label: providerEntry?.displayName ?? provider,
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

/**
 * Author and activate a user profile for a provider the code-defined defaults
 * cannot serve. Named after the provider — never `custom-balanced` or another
 * default-sounding name, so it can't shadow the read-only default rail.
 */
async function applyCustomProviderProfile(
  assistantId: string,
  provider: OnboardingProviderId,
  model: string,
): Promise<void> {
  const { response: putResponse } = await configLlmProfilesByNamePut({
    path: { assistant_id: assistantId, name: provider },
    body: buildCustomProviderProfile(provider, model),
    throwOnError: false,
  });
  ensureOk(putResponse, "Failed to set provider profile");
  const { response: patchResponse } = await configPatch({
    path: { assistant_id: assistantId },
    body: { llm: { activeProfile: provider } },
    throwOnError: false,
  });
  ensureOk(patchResponse, "Failed to activate provider profile");
}

/**
 * Legacy write path for assistants below the onboarding-default-provider
 * gate: they have no code-defined BYOK defaults, so the picked provider must
 * be materialized client-side the way onboarding always did — a
 * provider-named connection plus an authored-and-activated `custom-balanced`
 * profile. Newer daemons understand these writes too (their BYOK conversion
 * pass migrates the profile onto the default rail), so this is also the safe
 * landing when the daemon version cannot be resolved.
 */
async function applyLegacyOnboardingProfile(
  assistantId: string,
  pending: PendingProviderKey,
  hasKey: boolean,
): Promise<void> {
  await createCustomProviderConnection(assistantId, pending.provider, hasKey, {
    baseUrl: pending.baseUrl,
    customModels: pending.customModels,
  });
  const model =
    pending.model?.trim() ||
    defaultModelForOnboardingProvider(pending.provider);
  if (!model) {
    return;
  }
  const { response: putResponse } = await configLlmProfilesByNamePut({
    path: { assistant_id: assistantId, name: LEGACY_ONBOARDING_ACTIVE_PROFILE },
    body: {
      ...buildCustomProviderProfile(pending.provider, model),
      label: "Balanced",
      description: "Good balance of quality, cost, and speed",
    },
    throwOnError: false,
  });
  ensureOk(putResponse, "Failed to set provider profile");
  const { response: patchResponse } = await configPatch({
    path: { assistant_id: assistantId },
    body: { llm: { activeProfile: LEGACY_ONBOARDING_ACTIVE_PROFILE } },
    throwOnError: false,
  });
  ensureOk(patchResponse, "Failed to activate provider profile");
}

/**
 * Apply the model-provider selection collected during onboarding to the
 * freshly hatched local assistant. Consumes the pending key; no-op when nothing
 * was collected (e.g. Vellum Cloud, which skips the API-key step). Throws
 * {@link ProviderKeyRejectedError} when the daemon's provider-side validation
 * rejects the key, re-staging the full selection so the API-key screen can
 * prefill on the correction pass (and a reload re-applies and re-surfaces
 * the rejection).
 *
 * API-key providers rely on the daemon's code-defined default profiles: store
 * the key, create the `<provider>-personal` connection the defaults dispatch
 * through, and point `llm.defaultProvider` at the picked provider. The hatch
 * already activated `balanced`, so no profile is written. Only providers the
 * matrix cannot serve (Ollama, openai-compatible) get a client-authored
 * profile. Assistants predating the code-defined defaults get the legacy
 * custom-balanced authoring flow instead.
 */
export async function applyPendingProviderKey(
  assistantId: string,
): Promise<void> {
  const pending = consumePendingProviderKey();
  if (!pending) {
    return;
  }
  try {
    await applyProviderSelection(assistantId, pending);
  } catch (err) {
    if (err instanceof ProviderKeyRejectedError) {
      // A rejected key is user-correctable: re-stage the collected selection,
      // rejected key included, so the API-key screen prefills for correction.
      // The key is deliberately KEPT: the hold on the error screen is
      // in-memory, so a reload there re-runs the apply, and re-applying the
      // bad key re-surfaces this rejection. A cleared key would instead
      // no-op the apply and hand the user a provider-less assistant, which
      // is the silent dead-chat state this error exists to prevent.
      setPendingProviderKey(pending);
    }
    throw err;
  }
}

async function applyProviderSelection(
  assistantId: string,
  pending: PendingProviderKey,
): Promise<void> {
  const trimmed = pending.key.trim();

  if (!PROFILE_AUTHORING_PROVIDERS.has(pending.provider)) {
    await writeApiKeySecret(assistantId, pending.provider, trimmed);
    if (await supportsOnboardingDefaultProvider(assistantId)) {
      await createPersonalConnection(assistantId, pending.provider);
      await setDefaultProvider(assistantId, pending.provider);
    } else {
      await applyLegacyOnboardingProfile(
        assistantId,
        pending,
        trimmed.length > 0,
      );
    }
    return;
  }

  const hasKey = trimmed.length > 0;
  const isOpenAICompatible = pending.provider === "openai-compatible";
  if (hasKey || isOpenAICompatible) {
    await writeApiKeySecret(assistantId, pending.provider, trimmed);
  }
  await createCustomProviderConnection(assistantId, pending.provider, hasKey, {
    baseUrl: pending.baseUrl,
    customModels: pending.customModels,
  });
  const selectedModel = pending.model?.trim();
  const firstCustomModel = pending.customModels
    ?.split(",")
    .map((s) => s.trim())
    .find((s) => s);
  const model =
    selectedModel ||
    firstCustomModel ||
    defaultModelForOnboardingProvider(pending.provider);
  if (model) {
    await applyCustomProviderProfile(assistantId, pending.provider, model);
  }
}
