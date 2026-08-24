/**
 * Which apps the user pinned to the sidebar, and in what order.
 *
 * A pin is a preference *about* an app rather than part of one, so it lives
 * beside the apps in `<workspace>/data/app-pins.json` instead of inside each
 * app's own record. Plugin apps are pinnable and their records belong to the
 * plugin that ships them, so for those there is no per-app file to write.
 *
 * The store holds ids alone. Display fields (name, icon) are read from the app
 * itself at list time, so a renamed app renames its pin, and a pin whose app is
 * gone surfaces nowhere.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureDir, readTextFileSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("app-pin-store");

export interface AppPin {
  appId: string;
  /** 1-based position in the sidebar. Contiguous across the stored list. */
  pinnedOrder: number;
  /** An id from the client's pinned-app colour registry. Absent when unset. */
  color?: string;
}

function pinsFilePath(): string {
  return join(getDataDir(), "app-pins.json");
}

function isValidPin(value: unknown): value is AppPin {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.appId === "string" &&
    record.appId.length > 0 &&
    typeof record.pinnedOrder === "number" &&
    Number.isFinite(record.pinnedOrder) &&
    (record.color === undefined || typeof record.color === "string")
  );
}

/**
 * Renumber to a contiguous 1-based sequence in the order given, dropping any
 * duplicate id. Every write goes through this, so `pinnedOrder` is a position
 * rather than an ever-growing counter and unpinning leaves no gap.
 */
function compact(pins: AppPin[]): AppPin[] {
  const seen = new Set<string>();
  const result: AppPin[] = [];
  for (const pin of pins) {
    if (seen.has(pin.appId)) {
      continue;
    }
    seen.add(pin.appId);
    result.push({ ...pin, pinnedOrder: result.length + 1 });
  }
  return result;
}

/**
 * Every stored pin, ordered. Invalid entries are dropped rather than failing
 * the read: a pin list is a preference, and one corrupt entry must not cost the
 * user the rest of their sidebar.
 */
export function listAppPins(): AppPin[] {
  const raw = readTextFileSync(pinsFilePath());
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return compact(
      parsed.filter(isValidPin).sort((a, b) => a.pinnedOrder - b.pinnedOrder),
    );
  } catch (err) {
    log.warn({ err }, "Unreadable app-pins.json, treating as empty");
    return [];
  }
}

function writePins(pins: AppPin[]): AppPin[] {
  const compacted = compact(pins);
  /* `getDataDir` only builds the path. On a workspace where nothing has
     created the data dir yet, the first pin is what creates it. */
  ensureDir(getDataDir());
  writeFileSync(pinsFilePath(), JSON.stringify(compacted, null, 2) + "\n");
  return compacted;
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
 * conjure a pin that unpinning just removed. Pinning appends to the end.
 */
export function updateAppPin(
  appId: string,
  update: AppPinUpdate,
): AppPin | null {
  const pins = listAppPins();
  const existing = pins.find((pin) => pin.appId === appId);

  if (update.pinned === false) {
    writePins(pins.filter((pin) => pin.appId !== appId));
    return null;
  }

  if (!existing && update.pinned !== true) {
    return null;
  }

  const base: AppPin = existing ?? { appId, pinnedOrder: pins.length + 1 };
  const next: AppPin = { appId: base.appId, pinnedOrder: base.pinnedOrder };
  const color =
    update.color === undefined ? base.color : (update.color ?? undefined);
  if (color !== undefined) {
    next.color = color;
  }

  const written = writePins(
    existing
      ? pins.map((pin) => (pin.appId === appId ? next : pin))
      : [...pins, next],
  );
  return written.find((pin) => pin.appId === appId) ?? null;
}

/**
 * Drop an app's pin as part of deleting it, so the pin does not outlive the app
 * it points at. A no-op when the app was not pinned.
 */
export function removeAppPin(appId: string): void {
  const pins = listAppPins();
  if (!pins.some((pin) => pin.appId === appId)) {
    return;
  }
  writePins(pins.filter((pin) => pin.appId !== appId));
}
