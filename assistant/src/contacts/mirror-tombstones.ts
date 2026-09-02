/**
 * Short-lived tombstones for deleted mirror contacts.
 *
 * The mirror reconciler pulls a gateway identity snapshot and then applies it;
 * a contact deleted (or merged away) while that pull is in flight would be
 * resurrected from the stale snapshot, and the reconciler's additive contract
 * (it never deletes) would keep the ghost forever. Recording each deletion
 * here lets the reconciler refuse to heal an id that died after the snapshot
 * was taken.
 *
 * Contact ids are UUIDs and never come back, so a tombstone can never block
 * a legitimate recreation; the TTL only bounds memory.
 */

/** Generously longer than a snapshot pull plus its debounced follow-up. */
const TOMBSTONE_TTL_MS = 15 * 60 * 1000;

const tombstones = new Map<string, number>();

/** Record that the mirror contact row for `contactId` was deleted. */
export function recordContactTombstone(contactId: string): void {
  const now = Date.now();
  tombstones.set(contactId, now + TOMBSTONE_TTL_MS);
  for (const [id, expiresAt] of tombstones) {
    if (expiresAt <= now) {
      tombstones.delete(id);
    }
  }
}

/** Whether `contactId` was deleted recently enough that a snapshot may predate it. */
export function isContactTombstoned(contactId: string): boolean {
  const expiresAt = tombstones.get(contactId);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    tombstones.delete(contactId);
    return false;
  }
  return true;
}
