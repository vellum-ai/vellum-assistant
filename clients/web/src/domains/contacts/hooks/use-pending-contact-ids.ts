/**
 * The contact ids one page-global mutation currently has a request open for.
 *
 * A mutation observer describes only its newest call, so `isPending` plus the
 * variables it reports names the wrong contact as soon as two calls overlap.
 * Holding the ids instead keeps each contact's answer its own. One instance
 * per mutation: a pending delete and a pending save mean different things.
 */
import { useCallback, useState } from "react";

export interface PendingContactIds {
  ids: ReadonlySet<string>;
  add: (contactId: string) => void;
  remove: (contactId: string) => void;
}

export function usePendingContactIds(): PendingContactIds {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());

  // Both bail on a no-op so the set keeps its identity when nothing changed.
  const add = useCallback((contactId: string) => {
    setIds((prev) =>
      prev.has(contactId) ? prev : new Set(prev).add(contactId),
    );
  }, []);

  const remove = useCallback((contactId: string) => {
    setIds((prev) => {
      if (!prev.has(contactId)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(contactId);
      return next;
    });
  }, []);

  return { ids, add, remove };
}
