import {
  inferenceProviderconnectionsPost,
  secretsPost,
} from "@/generated/daemon/sdk.gen";
import type { OnboardingProviderId } from "@/domains/onboarding/provider-catalog";

export interface PendingProviderKey {
  provider: OnboardingProviderId;
  /** Empty for keyless providers (e.g. Ollama). */
  key: string;
}

let pendingKey: PendingProviderKey | null = null;

export function setPendingProviderKey(value: PendingProviderKey | null): void {
  pendingKey = value;
}

export function peekPendingProviderKey(): PendingProviderKey | null {
  return pendingKey;
}

export function consumePendingProviderKey(): PendingProviderKey | null {
  const value = pendingKey;
  pendingKey = null;
  return value;
}

// Daemon wrappers via the generated SDK. Duplicated minimally here rather
// than importing domains/settings/ai/provider-connections-client (cross-domain
// imports are ESLint-gated in apps/web).

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
): Promise<void> {
  const auth = hasKey
    ? { type: "api_key" as const, credential: `credential/${provider}/api_key` }
    : { type: "none" as const };
  const { response } = await inferenceProviderconnectionsPost({
    path: { assistant_id: assistantId },
    body: { name: provider, provider, auth },
    throwOnError: false,
  });
  if (!response?.ok) {
    throw Object.assign(new Error("Failed to create provider connection"), {
      status: response?.status,
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
  if (hasKey) {
    await writeApiKeySecret(assistantId, pending.provider, trimmed);
  }
  await createProviderConnection(assistantId, pending.provider, hasKey);
}
