/**
 * Serializes asynchronous push-channel work per conversation while allowing
 * independent conversations to proceed concurrently.
 */
export type ConversationTaskQueue = {
  enqueue<T>(
    conversationExternalId: string,
    task: () => Promise<T> | T,
  ): Promise<T>;
};

export function createConversationTaskQueue(): ConversationTaskQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    enqueue<T>(
      conversationExternalId: string,
      task: () => Promise<T> | T,
    ): Promise<T> {
      const previous = tails.get(conversationExternalId) ?? Promise.resolve();
      const current: Promise<T> = previous.then(() => task());
      const tail = current.then(
        () => undefined,
        () => undefined,
      );
      tails.set(conversationExternalId, tail);
      void tail.then(() => {
        if (tails.get(conversationExternalId) === tail) {
          tails.delete(conversationExternalId);
        }
      });
      return current;
    },
  };
}
