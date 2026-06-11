import { setSelectedAssistant } from "@/assistant/selection";

/**
 * Switch the active platform assistant.
 *
 * Thin alias over the unified `setSelectedAssistant` write path so all writes
 * (per-org cache + lockfile `activeAssistant` mirror) go through one place. The
 * name/signature is kept for existing callers (e.g. `assistant-picker.tsx`).
 */
export async function selectPlatformAssistant(
  assistantId: string,
): Promise<void> {
  await setSelectedAssistant(assistantId);
}
