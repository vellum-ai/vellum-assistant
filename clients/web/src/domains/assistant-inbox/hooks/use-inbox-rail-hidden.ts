import { useCallback, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_ASSISTANT_INBOX_HIDDEN } from "@/utils/local-settings-keys";

function subscribe(onChange: () => void): () => void {
  return watchSetting(LS_ASSISTANT_INBOX_HIDDEN, onChange);
}

function readHidden(): boolean {
  return getLocalSetting(LS_ASSISTANT_INBOX_HIDDEN, "0") === "1";
}

export interface InboxRailHidden {
  /** The user dismissed the Assistant Inbox entry from the side menu. */
  hidden: boolean;
  hide: () => void;
  /** Put the entry back. */
  restore: () => void;
}

/**
 * Whether the user has taken the Assistant Inbox entry off the side menu,
 * read live from the device-local setting. Subscribed rather than read once,
 * because the control that restores the entry lives on another surface (the
 * Channels page) while the rail is mounted beside it: restoring there has to
 * bring the pill back without a reload, and in other tabs too.
 */
export function useInboxRailHidden(): InboxRailHidden {
  const hidden = useSyncExternalStore(subscribe, readHidden, () => false);

  const hide = useCallback(() => {
    setLocalSetting(LS_ASSISTANT_INBOX_HIDDEN, "1");
  }, []);
  const restore = useCallback(() => {
    removeLocalSetting(LS_ASSISTANT_INBOX_HIDDEN);
  }, []);

  return { hidden, hide, restore };
}
