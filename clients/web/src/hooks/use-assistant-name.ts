import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

function resolveAssistantName(
  assistantId: string | null,
  identity: { assistantId: string | null; name: string | null },
  assistants: { id: string; name?: string }[],
): string | null {
  if (!assistantId) {
    return null;
  }
  if (identity.assistantId === assistantId) {
    const name = identity.name?.trim();
    if (name) {
      return name;
    }
  }
  return (
    assistants
      .find((assistant) => assistant.id === assistantId)
      ?.name?.trim() || null
  );
}

export function readAssistantName(assistantId: string | null): string | null {
  return resolveAssistantName(
    assistantId,
    useAssistantIdentityStore.getState(),
    useResolvedAssistantsStore.getState().assistants,
  );
}

export function useAssistantName(assistantId: string | null): string | null {
  const name = useAssistantIdentityStore.use.name();
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  return resolveAssistantName(
    assistantId,
    { assistantId: identityAssistantId, name },
    assistants,
  );
}
