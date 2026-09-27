import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  notifySettingChange,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX } from "@/utils/local-settings-keys";

/**
 * As many deleted ids as one assistant's entry keeps. The lists page at 50,
 * so this is many pages of mail; past it the oldest deletions fall off,
 * which matters only for a message that old coming back into view.
 */
const MAX_DELETED_IDS = 1000;

function keyFor(assistantId: string): string {
  return `${LS_ASSISTANT_INBOX_DELETED_EMAILS_PREFIX}${assistantId}`;
}

/**
 * The entry as last written, for a device where the write did not reach
 * storage (private browsing, a full quota, a policy block). The rows the
 * user deleted stay hidden for the session either way; only the persistence
 * is lost.
 */
const unpersisted = new Map<string, string>();

/** The raw entry: what storage holds, else what this session wrote. */
function readRaw(key: string): string {
  return getLocalSetting(key, "") || (unpersisted.get(key) ?? "");
}

/** The stored ids, or none for an absent or unreadable entry. */
export function readDeletedEmailIds(assistantId: string): string[] {
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

/** Append ids to the stored entry, newest last, bounded to {@link MAX_DELETED_IDS}. */
export function appendDeletedEmailIds(
  assistantId: string,
  ids: string[],
): void {
  const merged = new Set(readDeletedEmailIds(assistantId));
  for (const id of ids) {
    merged.add(id);
  }
  const bounded = [...merged].slice(-MAX_DELETED_IDS);
  const key = keyFor(assistantId);
  const serialized = JSON.stringify(bounded);
  if (setLocalSetting(key, serialized)) {
    unpersisted.delete(key);
    return;
  }
  // A refused write fires no notification of its own, so the subscribers
  // are told here, and the read falls back to what was written.
  unpersisted.set(key, serialized);
  notifySettingChange(key, serialized);
}

export interface DeletedEmails {
  /** Ids the user has deleted from this assistant's inbox on this device. */
  deletedIds: ReadonlySet<string>;
  /** Mark these ids deleted. */
  deleteEmails: (ids: string[]) => void;
}

/**
 * Which messages the user has deleted from the inbox, kept on the device.
 *
 * The platform stores mail per assistant and offers no delete for a single
 * message (see `assistants_emails_list` in the platform spec: the collection
 * is read-only), so "Delete from inbox" cannot remove anything from the
 * server. What it can do is honour the request on this device: the ids are
 * kept in a local setting and the mailbox filters them out of both folders.
 * Subscribed rather than read once so a deletion made in another tab hides
 * the rows here too. When the platform grows a delete, this is the seam to
 * replace.
 */
export function useDeletedEmails(assistantId: string): DeletedEmails {
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
  const deletedIds = useMemo(
    () => new Set(raw ? readDeletedEmailIds(assistantId) : []),
    [assistantId, raw],
  );

  const deleteEmails = useCallback(
    (ids: string[]) => {
      if (ids.length > 0) {
        appendDeletedEmailIds(assistantId, ids);
      }
    },
    [assistantId],
  );

  return { deletedIds, deleteEmails };
}
