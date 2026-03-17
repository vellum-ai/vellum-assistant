/**
 * Shared policy for conversation starter generation cadence.
 */

export const CK_CONVERSATION_STARTERS_ITEM_COUNT =
  "conversation_starters:item_count_at_last_gen";
export const CK_CONVERSATION_STARTERS_BATCH =
  "conversation_starters:generation_batch";
export const CK_CONVERSATION_STARTERS_LAST_GEN_AT =
  "conversation_starters:last_gen_at";
export const CK_CONVERSATION_STARTERS_LAST_ATTEMPT_AT =
  "conversation_starters:last_attempt_at";

export const CONVERSATION_STARTERS_MIN_REGEN_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const CONVERSATION_STARTERS_ATTEMPT_COOLDOWN_MS = 15 * 60 * 1000;

export function conversationStartersCheckpointKey(
  base: string,
  scopeId: string,
): string {
  return `${base}:${scopeId}`;
}

export function conversationStartersGenerationThreshold(
  totalActive: number,
): number {
  if (totalActive <= 10) return 5;
  if (totalActive <= 50) return 10;
  return 20;
}
