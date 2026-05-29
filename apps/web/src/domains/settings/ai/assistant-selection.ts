export interface AssistantListLike {
  results?: Array<{ id?: string | null }> | null;
}

export type AiSettingsAssistantListHosting = "local" | "platform";

export interface AiSettingsAssistantStateLike {
  kind: string;
  isLocal?: boolean;
}

export function isSelfHostedAiSettingsAssistant(
  assistantState: AiSettingsAssistantStateLike,
): boolean {
  return (
    assistantState.kind === "self_hosted" ||
    (assistantState.kind === "active" && assistantState.isLocal === true)
  );
}

export function aiSettingsAssistantListHosting(
  isSelfHosted: boolean,
): AiSettingsAssistantListHosting {
  return isSelfHosted ? "local" : "platform";
}

export function resolveAiSettingsAssistantId({
  isSelfHosted,
  lifecycleAssistantId,
  assistantList,
}: {
  isSelfHosted: boolean;
  lifecycleAssistantId: string | null;
  assistantList?: AssistantListLike | null;
}): string | undefined {
  if (isSelfHosted && lifecycleAssistantId) {
    return lifecycleAssistantId;
  }

  return assistantList?.results?.[0]?.id ?? undefined;
}
