/**
 * Which apps the user pinned to the sidebar, and in what order.
 *
 * Rows hold ids alone. Name and icon are read from the app itself at list
 * time, so a renamed app renames its pin, and a pin whose app is gone surfaces
 * nowhere.
 */

import { eq, max } from "drizzle-orm";

import { getDb } from "../persistence/db-connection.js";
import { appPins } from "../persistence/schema/index.js";

export interface AppPin {
  appId: string;
  /** Fractional index. Ascending is sidebar order; the values are not dense. */
  sortPosition: number;
  /** An id from the client's pinned-app colour registry. Absent when unset. */
  color?: string;
}

function toPin(row: {
  appId: string;
  sortPosition: number;
  color: string | null;
}): AppPin {
  return {
    appId: row.appId,
    sortPosition: row.sortPosition,
    ...(row.color === null ? {} : { color: row.color }),
  };
}

/** Every pin, in sidebar order. */
export function listAppPins(): AppPin[] {
  return getDb()
    .select()
    .from(appPins)
    .orderBy(appPins.sortPosition)
    .all()
    .map(toPin);
}

function getAppPin(appId: string): AppPin | null {
  const row = getDb()
    .select()
    .from(appPins)
    .where(eq(appPins.appId, appId))
    .get();
  return row ? toPin(row) : null;
}

/** One past the last pin, so pinning appends. */
function nextSortPosition(): number {
  const highest = getDb()
    .select({ value: max(appPins.sortPosition) })
    .from(appPins)
    .get();
  return (highest?.value ?? 0) + 1;
}

export interface AppPinUpdate {
  /** Pin or unpin. Omitted leaves the app's pinned state as it stands. */
  pinned?: boolean;
  /** Set (string) or clear (`null`) the colour. Omitted leaves it as it stands. */
  color?: string | null;
}

/**
 * Apply a pin change and return the app's resulting pin, or `null` once it is
 * no longer pinned.
 *
 * A colour for an app that is not pinned is dropped, so a colour can never
 * conjure a pin that unpinning just removed.
 */
export function updateAppPin(
  appId: string,
  update: AppPinUpdate,
): AppPin | null {
  if (update.pinned === false) {
    removeAppPin(appId);
    return null;
  }

  const existing = getAppPin(appId);
  if (!existing && update.pinned !== true) {
    return null;
  }

  const color = update.color === undefined ? existing?.color : update.color;
  const db = getDb();
  const sortPosition = existing?.sortPosition ?? nextSortPosition();

  if (existing) {
    db.update(appPins)
      .set({ color: color ?? null })
      .where(eq(appPins.appId, appId))
      .run();
  } else {
    /* `onConflictDoUpdate` rather than a plain insert: two clients pinning the
       same app at once would otherwise race on the primary key. */
    db.insert(appPins)
      .values({
        appId,
        sortPosition,
        color: color ?? null,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: appPins.appId,
        set: { color: color ?? null },
      })
      .run();
  }

  return { appId, sortPosition, ...(color == null ? {} : { color }) };
}

/**
 * Drop an app's pin as part of deleting it, so the pin does not outlive the app
 * it points at. A no-op when the app was not pinned.
 */
export function removeAppPin(appId: string): void {
  getDb().delete(appPins).where(eq(appPins.appId, appId)).run();
}
