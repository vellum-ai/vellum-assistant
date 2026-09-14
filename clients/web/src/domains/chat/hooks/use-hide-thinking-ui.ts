import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

/**
 * Whether the transcript shows the assistant's reasoning at all.
 *
 * Under `send-user-message` the assistant speaks through a tool call, which
 * makes every word it writes outside that call a working note. Reasoning is
 * then not a second view of the answer but the raw draft behind it, so the
 * transcript drops the whole thinking surface: the rows, the "Thinking" label
 * (on its own and paired with a tool's), the drawer, and the shimmer's word
 * for the wait. Tool rows, surfaces, and the delivered text are untouched.
 *
 * A blunt gate on top of the per-row `assistantTextVisibility` marker, which
 * says the same thing about one row rather than the whole transcript.
 */
export function useHideThinkingUi(): boolean {
  return useAssistantFeatureFlagStore.use.sendUserMessage();
}
