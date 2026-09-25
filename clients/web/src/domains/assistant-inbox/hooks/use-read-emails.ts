import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  notifySettingChange,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_ASSISTANT_INBOX_READ_EMAILS_PREFIX } from "@/utils/local-settings-keys";

/** As many read ids as one assistant's entry keeps; the oldest fall off past it. */
const MAX_READ_IDS = 2000;

function keyFor(assistantId: string): string {
  return `${LS_ASSISTANT_INBOX_READ_EMAILS_PREFIX}${assistantId}`;
}

/** The entry as last written, where the write did not reach storage. */
const unpersisted = new Map<string, string>();

function readRaw(key: string): string {
  return getLocalSetting(key, "") || (unpersisted.get(key) ?? "");
}

/** The stored ids, or none for an absent or unreadable entry. */
export function readReadEmailIds(assistantId: string): string[] {
  const raw = readRaw(keyFor(assistantId));
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/** Append an id to the stored entry, newest last, bounded to {@link MAX_READ_IDS}. */
export function appendReadEmailId(assistantId: string, id: string): void {
  const merged = new Set(readReadEmailIds(assistantId));
  if (merged.has(id)) {
    return;
  }
  merged.add(id);
  const key = keyFor(assistantId);
  const serialized = JSON.stringify([...merged].slice(-MAX_READ_IDS));
  if (setLocalSetting(key, serialized)) {
    unpersisted.delete(key);
    return;
  }
  unpersisted.set(key, serialized);
  notifySettingChange(key, serialized);
}

export interface ReadEmails {
  /** Ids of messages the user has opened on this device. */
  readIds: ReadonlySet<string>;
  markRead: (id: string) => void;
}

/**
 * Which messages the user has opened, kept on the device: the platform
 * stores no read state for a message, so the unread mark in the list is
 * this device's memory of what was opened here. A message is read once it
 * has been open in the reading pane; nothing marks one unread again.
 */
export function useReadEmails(assistantId: string): ReadEmails {
  const key = keyFor(assistantId);
  const subscribe = useCallback(
    (onChange: () => void) => watchSetting(key, onChange),
    [key],
  );
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => "",
  );
  const readIds = useMemo(
    () => new Set(raw ? readReadEmailIds(assistantId) : []),
    [assistantId, raw],
  );
  const markRead = useCallback(
    (id: string) => appendReadEmailId(assistantId, id),
    [assistantId],
  );
  return { readIds, markRead };
}
