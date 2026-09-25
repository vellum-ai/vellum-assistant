import { useCallback, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_ASSISTANT_INBOX_PINNED_PREFIX } from "@/utils/local-settings-keys";

function keyFor(assistantId: string): string {
  return `${LS_ASSISTANT_INBOX_PINNED_PREFIX}${assistantId}`;
}

export interface EmailPinned {
  /** The user pinned this assistant's Email to the side menu on this device. */
  pinned: boolean;
  pin: () => void;
  unpin: () => void;
  toggle: () => void;
}

/**
 * Whether the assistant's Email is pinned to the side menu, kept on the
 * device like the pinned apps are. Shared between the profile card that
 * pins it and the side menu that draws the pin, so it lives above both
 * domains. Subscribed rather than read once: the pin is toggled on one
 * surface while the other is on screen.
 */
export function useEmailPinned(assistantId: string | null): EmailPinned {
  const key = keyFor(assistantId ?? "");
  const subscribe = useCallback(
    (onChange: () => void) => watchSetting(key, onChange),
    [key],
  );
  const pinned = useSyncExternalStore(
    subscribe,
    () => assistantId !== null && getLocalSetting(key, "0") === "1",
    () => false,
  );
  const pin = useCallback(() => {
    if (assistantId !== null) {
      setLocalSetting(key, "1");
    }
  }, [assistantId, key]);
  const unpin = useCallback(() => removeLocalSetting(key), [key]);
  const toggle = useCallback(() => {
    if (pinned) {
      unpin();
    } else {
      pin();
    }
  }, [pin, pinned, unpin]);
  return { pinned, pin, unpin, toggle };
}
