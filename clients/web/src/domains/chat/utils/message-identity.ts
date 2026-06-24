import type { DisplayMessage } from "@/domains/chat/types/types";

/**
 * Identity helpers shared by the snapshot/stream reconcilers.
 *
 * A message can be known by more than one id: its own `id` plus any
 * `mergedMessageIds` the daemon collapsed into it. Matching a local row to
 * a server row, or detecting whether a local row is reflected on the
 * server, must consider all of those keys — comparing only `id` misses
 * rows that were merged after the local copy was built.
 */

export type MessageIdentity = {
  id?: string;
  mergedMessageIds?: string[];
};

/** All distinct, non-empty ids a message can be matched by. */
export function messageIdentityKeys(message: MessageIdentity): string[] {
  return [
    ...new Set(
      [message.id, ...(message.mergedMessageIds ?? [])].filter(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
    ),
  ];
}

/**
 * All ids a row can be matched on, including the client nonce. An optimistic
 * row and the server echo of it correlate on `clientMessageId`, not on a shared
 * server `id`, so transcript overlay and the live-turn→history handoff must
 * consider the nonce on top of the server-id keys.
 */
export function messageMatchKeys(message: DisplayMessage): string[] {
  const keys = messageIdentityKeys(message);
  if (message.clientMessageId && !keys.includes(message.clientMessageId)) {
    return [...keys, message.clientMessageId];
  }
  return keys;
}

/** Register a message under each of its identity keys (first writer wins). */
export function indexDisplayMessageByIdentity(
  indexById: Map<string, DisplayMessage>,
  message: DisplayMessage,
): void {
  for (const id of messageIdentityKeys(message)) {
    if (!indexById.has(id)) {
      indexById.set(id, message);
    }
  }
}

/** Find a previously-indexed local row matching any of another row's ids. */
export function findDisplayMessageByRuntimeIdentity(
  indexById: Map<string, DisplayMessage>,
  message: MessageIdentity,
): DisplayMessage | undefined {
  for (const id of messageIdentityKeys(message)) {
    const existing = indexById.get(id);
    if (existing) {
      return existing;
    }
  }
  return undefined;
}

/** Whether any of a local row's identity keys appears in the server set. */
export function hasServerIdentity(
  serverIds: Set<string>,
  message: DisplayMessage,
): boolean {
  return messageIdentityKeys(message).some((id) => serverIds.has(id));
}
