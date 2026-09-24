interface VisibleChat {
  users: number;
  refreshedAt: number;
  revision: number;
  requestedRevision: number;
}

/** Bounds, deduplicates, and refreshes activity reads for mounted virtual rows. */
export function createVisibleChatReconciler(
  reconcile: (id: string, isCurrent: () => boolean) => Promise<void>,
  { concurrency = 3, staleMs = 30_000, now = Date.now } = {},
) {
  const chats = new Map<string, VisibleChat>();
  const running = new Set<string>();
  let generation = 0;
  let active = false;

  function pump() {
    if (!active) {
      return;
    }
    for (const [id, chat] of chats) {
      if (running.size >= concurrency) {
        break;
      }
      if (
        !chat.users ||
        running.has(id) ||
        (chat.revision === chat.requestedRevision &&
          now() - chat.refreshedAt < staleMs)
      ) {
        continue;
      }
      running.add(id);
      const startedGeneration = generation;
      const startedRevision = chat.requestedRevision;
      const isCurrent = () => active && generation === startedGeneration;
      void reconcile(id, isCurrent)
        .catch(() => {
          // A failed read retains the last known status until the next refresh.
        })
        .finally(() => {
          running.delete(id);
          if (isCurrent()) {
            chat.refreshedAt = now();
            chat.revision = startedRevision;
          }
          pump();
        });
    }
  }

  return {
    start() {
      active = true;
      pump();
    },
    stop() {
      active = false;
      generation++;
    },
    register(id: string) {
      const chat = chats.get(id) ?? {
        users: 0,
        refreshedAt: 0,
        revision: -1,
        requestedRevision: 0,
      };
      chat.users++;
      chats.set(id, chat);
      pump();
      return () => {
        chat.users = Math.max(0, chat.users - 1);
      };
    },
    refresh(id?: string) {
      for (const [key, chat] of chats) {
        if (id === undefined || key === id) {
          chat.requestedRevision++;
        }
      }
      pump();
    },
  };
}
