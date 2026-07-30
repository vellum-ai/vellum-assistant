/**
 * User-controlled ordering for the sidebar's conversation-list sections
 * (Pinned, Chats, each origin-channel section, each custom group).
 *
 * **Key namespace.** A section's order key *is* its accordion `value` -
 * `"pinned"`, `"recents"`, `"channel:<channelId>"`, or a custom group's
 * (uuid) id. One namespace means the collapse state and the layout order
 * can never disagree about what a section is called.
 *
 * **Storage model.** The stored value is a `string[]` preference list, kept
 * per assistant in localStorage under the `user` scope (cleared on logout),
 * matching how the collapse state persists. It is deliberately *sparse and
 * advisory* rather than the source of truth for what renders:
 *
 * - Keys the stored order doesn't mention still render - they slot in next to
 *   their default-order neighbour (see {@link mergeSectionOrder}). A group
 *   created after the last drag appears where the default order puts it, not
 *   silently at the bottom.
 * - Keys naming a section that does not exist are ignored on read, so a
 *   deleted group's leftover key can't leave a hole in the layout.
 *
 * **Sections come and go.** Pinned renders only when something is pinned, a
 * channel section only exists while that channel has conversations, and the
 * groups query resolves after first paint. A section missing from the live
 * list is therefore never treated as deleted: {@link nextStoredOrder} keeps
 * its slot, so anything that returns lands where the user left it.
 */

import { parseStringArray } from "@/domains/chat/utils/storage-validators";
import { createKeyedStorageAccessor } from "@/utils/typed-storage";

/**
 * Cap on the stored preference list. Absent keys are kept so a section that
 * comes back lands where the user left it, which means the list only grows.
 * Well past any real sidebar, and trimming the oldest absent keys past it
 * costs nothing: an absent key is inert on read.
 */
const MAX_STORED_KEYS = 100;

// ---------------------------------------------------------------------------
// Order merging
// ---------------------------------------------------------------------------

/**
 * Resolve the render order for `defaultKeys` under the user's stored
 * preference.
 *
 * Sections named in `stored` sort by their stored position. Sections that
 * aren't named - a group created since the last drag, a channel seen for the
 * first time - inherit the position of the nearest *preceding* section in
 * `defaultKeys`, so they appear next to the sections they default beside
 * rather than being swept to one end. Ties fall back to `defaultKeys` order,
 * which keeps the result deterministic.
 *
 * Only keys present in `defaultKeys` are returned: stale stored keys can't
 * conjure a section, and no section can be dropped by omitting it.
 */
export function mergeSectionOrder(
  defaultKeys: readonly string[],
  stored: readonly string[],
): string[] {
  const storedRank = new Map<string, number>();
  stored.forEach((key, index) => {
    // First occurrence wins, so a corrupted duplicate can't reshuffle anything.
    if (!storedRank.has(key)) {
      storedRank.set(key, index);
    }
  });

  // `anchor` is the stored position the current run of unknown sections
  // trails; `offset` orders that run. Unknown sections ahead of every stored
  // key anchor at -1 and therefore sort to the top.
  let anchor = -1;
  let offset = 0;
  const ranked = defaultKeys.map((key, defaultIndex) => {
    const rank = storedRank.get(key);
    if (rank == null) {
      offset += 1;
    } else {
      anchor = rank;
      offset = 0;
    }
    return { key, anchor, offset, defaultIndex };
  });

  return ranked
    .slice()
    .sort(
      (a, b) =>
        a.anchor - b.anchor ||
        a.offset - b.offset ||
        a.defaultIndex - b.defaultIndex,
    )
    .map((entry) => entry.key);
}

/**
 * The array to persist after the user reorders sections into `liveOrder`.
 *
 * `liveOrder` covers only the sections rendering at that moment, so writing it
 * verbatim would forget where everything else belongs. Every stored key it
 * omits is spliced back in behind whichever of its old neighbours survives.
 *
 * Absence is deliberately never read as deletion. A section can be missing
 * from `liveOrder` for reasons that have nothing to do with the user removing
 * it: Pinned is empty, a channel has gone quiet, or the groups query simply
 * has not resolved yet (`conversationGroups` is optional, so a reorder during
 * that window sees no group sections at all). Since those are indistinguishable
 * here, nothing is pruned, and a stale key costs nothing: {@link
 * mergeSectionOrder} only returns keys that name a live section, so a deleted
 * group's key is inert rather than a hole in the layout.
 */
export function nextStoredOrder(
  stored: readonly string[],
  liveOrder: readonly string[],
): string[] {
  const live = new Set(liveOrder);
  const result = [...liveOrder];

  const absent = stored.filter((key) => !live.has(key));

  // Walk in stored order so a run of absent keys stays internally ordered:
  // each one finds the previous one already placed.
  for (const key of absent) {
    const storedIndex = stored.indexOf(key);
    let insertAt = 0;
    for (let i = storedIndex - 1; i >= 0; i -= 1) {
      const previousPosition = result.indexOf(stored[i]!);
      if (previousPosition !== -1) {
        insertAt = previousPosition + 1;
        break;
      }
    }
    result.splice(insertAt, 0, key);
  }

  if (result.length <= MAX_STORED_KEYS) {
    return result;
  }
  // Over the cap, drop absent keys from the end. Live sections always keep
  // their slot; only long-unseen ones are forgotten.
  const absentKeys = new Set(absent);
  const trimmed = [...result];
  for (let i = trimmed.length - 1; i >= 0 && trimmed.length > MAX_STORED_KEYS; i -= 1) {
    if (absentKeys.has(trimmed[i]!)) {
      trimmed.splice(i, 1);
    }
  }
  return trimmed;
}

/**
 * `keys` with `key` moved one slot toward the start (`-1`) or end (`+1`).
 * Returns `null` when the move is a no-op - the key is missing or already at
 * that end - so callers can skip the write.
 *
 * This is the keyboard- and touch-reachable path to the same reordering that
 * drag-and-drop performs: HTML5 drag events don't fire on touch and aren't
 * operable from the keyboard, so drag alone would put section layout out of
 * reach for anyone not using a mouse.
 */
export function moveSectionKey(
  keys: readonly string[],
  key: string,
  delta: -1 | 1,
): string[] | null {
  const from = keys.indexOf(key);
  if (from === -1) {
    return null;
  }
  const to = from + delta;
  if (to < 0 || to >= keys.length) {
    return null;
  }
  const next = [...keys];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const sectionOrderStorage = createKeyedStorageAccessor<string[]>({
  keyFn: (assistantId) => `vellum:sidebar-section-order:${assistantId}`,
  scope: "user",
  parse: parseStringArray,
  serialize: JSON.stringify,
  // No stored preference means "use the default order" - an empty
  // preference list, which `mergeSectionOrder` resolves to exactly that.
  fallback: [],
});

export function loadSectionOrder(assistantId: string): string[] {
  return sectionOrderStorage.load(assistantId);
}

export function saveSectionOrder(assistantId: string, order: string[]): void {
  sectionOrderStorage.save(assistantId, order);
}
