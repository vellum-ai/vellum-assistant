import type { Conversation } from "@/types/conversation-types";

export interface SubGroup {
  key: string;
  label: string;
  conversations: Conversation[];
}

/**
 * Generic insertion-order-preserving grouping helper shared by the
 * background and scheduled sub-group modules.
 *
 * @param conversations - Flat list of conversations to partition.
 * @param getKey - Extract a grouping key from a conversation. Return an
 *   empty string to assign the conversation its own unique singleton key
 *   (`__single__:<conversationId>`).
 * @param makeLabel - Derive a human-readable label given the resolved key
 *   and the first conversation in the group.
 */
export function groupConversationsByKey(
  conversations: Conversation[],
  getKey: (c: Conversation) => string,
  makeLabel: (key: string, firstConversation: Conversation) => string,
): SubGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, SubGroup>();

  for (const conv of conversations) {
    const raw = getKey(conv);
    const key =
      raw.length > 0 ? raw : `__single__:${conv.conversationId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.conversations.push(conv);
    } else {
      byKey.set(key, {
        key,
        label: makeLabel(raw, conv),
        conversations: [conv],
      });
      order.push(key);
    }
  }

  return order.map((key) => {
    const group = byKey.get(key);
    if (!group) {
      throw new Error(`Sub-group missing for key ${key}`);
    }
    return group;
  });
}
