import { client } from "@/generated/api/client.gen";
import type { OnboardingProviderId } from "@/domains/onboarding/provider-catalog";

// Model-provider API key collected during onboarding. Held in sessionStorage
// (consume-once) between the API-key step and the post-hatch application, then
// written to the freshly hatched assistant. Mirrors the macOS flow, which
// holds the key in-memory and POSTs it to the daemon once the assistant is up.

const PENDING_KEY_STORAGE = "onboarding.providerKey";

const OPENAI_COMPATIBLE_FLAG = "openai-compatible-endpoints";

export interface PendingProviderKey {
  provider: OnboardingProviderId;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
  /** Custom endpoint base URL; set only for openai-compatible. */
  baseUrl?: string;
  /** Model identifiers exposed by the endpoint; set only for openai-compatible. */
  models?: string[];
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
    typeof value.key === "string"
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

// Daemon wrappers via the generated client. Duplicated minimally here rather
// than importing domains/settings/ai/provider-connections-client (cross-domain
// imports are ESLint-gated in apps/web).

// Raw template-literal URL (gateway route), matching
// assistant-feature-flag-store.ts; the generated client has no typed path for
// this endpoint.
async function enableAssistantFeatureFlag(
  assistantId: string,
  flagKey: string,
): Promise<void> {
  const result = await client.patch({
    url: `/v1/assistants/${assistantId}/feature-flags/${flagKey}`,
    body: { enabled: true },
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) {
    throw Object.assign(new Error("Failed to enable feature flag"), {
      status: result.response?.status,
    });
  }
}

async function writeApiKeySecret(
  assistantId: string,
  provider: OnboardingProviderId,
  value: string,
): Promise<void> {
  const result = await client.post({
    url: "/v1/assistants/{assistant_id}/secrets/",
    path: { assistant_id: assistantId },
    body: { type: "api_key", name: provider, value },
    headers: { "Content-Type": "application/json" },
  });
  if (!result.response?.ok) {
    throw Object.assign(new Error("Failed to write provider secret"), {
      status: result.response?.status,
    });
  }
}

async function createProviderConnection(
  assistantId: string,
  provider: OnboardingProviderId,
  hasKey: boolean,
  baseUrl?: string,
  models?: string[],
): Promise<void> {
  const auth = hasKey
    ? { type: "api_key", credential: `credential/${provider}/api_key` }
    : { type: "none" };
  const body = {
    name: provider,
    provider,
    auth,
    ...(baseUrl ? { base_url: baseUrl } : {}),
    ...(models && models.length > 0
      ? { models: models.map((id) => ({ id })) }
      : {}),
  };
  // The daemon refreshes its feature-flag cache asynchronously, so right after
  // enableAssistantFeatureFlag() returns it may still read
  // openai-compatible-endpoints as disabled and reject the create with HTTP 400.
  // Retry briefly to absorb that gateway->daemon propagation delay. Other
  // providers (and genuine validation 400s) surface immediately.
  const maxAttempts = provider === "openai-compatible" ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await client.post({
      url: "/v1/assistants/{assistant_id}/inference/provider-connections",
      path: { assistant_id: assistantId },
      body,
      headers: { "Content-Type": "application/json" },
    });
    if (result.response?.ok) return;
    const status = result.response?.status;
    if (provider === "openai-compatible" && status === 400 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    throw Object.assign(new Error("Failed to create provider connection"), {
      status,
    });
  }
}

/**
 * Apply the API key collected during onboarding to the freshly hatched local
 * assistant: store the secret (when a key was entered) and create the provider
 * connection so the daemon can use it. Consumes the pending key; no-op when
 * nothing was collected (e.g. Vellum Cloud, which skips the API-key step).
 */
export async function applyPendingProviderKey(
  assistantId: string,
): Promise<void> {
  const pending = consumePendingProviderKey();
  if (!pending) return;
  const trimmed = pending.key.trim();
  const hasKey = trimmed.length > 0;
  if (pending.provider === "openai-compatible") {
    await enableAssistantFeatureFlag(assistantId, OPENAI_COMPATIBLE_FLAG);
  }
  if (hasKey) {
    await writeApiKeySecret(assistantId, pending.provider, trimmed);
  }
  await createProviderConnection(
    assistantId,
    pending.provider,
    hasKey,
    pending.baseUrl?.trim() || undefined,
    pending.models,
  );
}
