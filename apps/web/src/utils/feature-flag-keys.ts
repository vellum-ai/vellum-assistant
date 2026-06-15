export const CLIENT_FLAG_QUERY_KEY = ["client-feature-flag-values"] as const;

export const ASSISTANT_FLAG_VALUES_QUERY_KEY =
  "assistant-feature-flag-values" as const;

export function assistantFlagValuesQueryKey(assistantId: string | null) {
  return [ASSISTANT_FLAG_VALUES_QUERY_KEY, assistantId] as const;
}
