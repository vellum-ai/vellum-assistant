/**
 * The display name interpolated into catalog copy that addresses the
 * assistant (teach-memory's title and description).
 *
 * Identity is the name the sidebar already shows. The resolved-assistants
 * row is the fallback when identity has not landed for this assistant yet.
 * Neither is required: a missing name becomes "your assistant" so the
 * sentence still reads, and never "it".
 */

import { useTranslation } from "@/i18n";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function resolveActivationAssistantName(
  name: string | null | undefined,
  fallback: string,
): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : fallback;
}

/** The name to interpolate, or null when nothing connected has one. */
export function readActivationAssistantName(
  assistantId: string | null,
): string | null {
  if (!assistantId) {
    return null;
  }
  const identity = useAssistantIdentityStore.getState();
  if (identity.assistantId === assistantId) {
    const identityName = identity.name?.trim();
    if (identityName) {
      return identityName;
    }
  }
  const resolved = useResolvedAssistantsStore
    .getState()
    .assistants.find((assistant) => assistant.id === assistantId)?.name;
  return resolved?.trim() || null;
}

/** Reactive {@link readActivationAssistantName} for render paths. */
export function useActivationAssistantName(): string | null {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const identityName = useAssistantIdentityStore.use.name();
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  if (!assistantId) {
    return null;
  }
  if (identityAssistantId === assistantId) {
    const trimmed = identityName?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return (
    assistants.find((assistant) => assistant.id === assistantId)?.name?.trim() ||
    null
  );
}

/** Fallback copy when no assistant name is in hand. */
export function useActivationAssistantNameOrFallback(): string {
  const { t } = useTranslation("activation");
  return resolveActivationAssistantName(
    useActivationAssistantName(),
    t("catalog.assistantFallback"),
  );
}
