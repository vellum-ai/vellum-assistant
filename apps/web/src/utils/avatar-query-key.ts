export const AVATAR_QUERY_KEY_PREFIX = "assistantAvatar";

export function avatarQueryKey(assistantId: string) {
  return [AVATAR_QUERY_KEY_PREFIX, assistantId] as const;
}
