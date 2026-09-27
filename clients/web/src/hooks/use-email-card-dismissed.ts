import { useCallback, useSyncExternalStore } from "react";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
  watchSetting,
} from "@/utils/local-settings";
import { LS_ASSISTANT_INBOX_CARD_DISMISSED_PREFIX } from "@/utils/local-settings-keys";

function keyFor(assistantId: string): string {
  return `${LS_ASSISTANT_INBOX_CARD_DISMISSED_PREFIX}${assistantId}`;
}

export interface EmailCardDismissed {
  /** The user closed the locked Email card on this device. */
  dismissed: boolean;
  dismiss: () => void;
  restore: () => void;
}

/**
 * Whether the user has closed the profile's Email card while it was a
 * pitch, kept on the device. Only honoured while the org's plan has no
 * managed email: the card is back the moment there is an inbox to open,
 * so the setting is never a way to lose a working inbox.
 */
export function useEmailCardDismissed(
  assistantId: string | null,
): EmailCardDismissed {
  const key = keyFor(assistantId ?? "");
  const subscribe = useCallback(
    (onChange: () => void) => watchSetting(key, onChange),
    [key],
  );
  const dismissed = useSyncExternalStore(
    subscribe,
    () => assistantId !== null && getLocalSetting(key, "0") === "1",
    () => false,
  );
  const dismiss = useCallback(() => {
    if (assistantId !== null) {
      setLocalSetting(key, "1");
    }
  }, [assistantId, key]);
  const restore = useCallback(() => removeLocalSetting(key), [key]);
  return { dismissed, dismiss, restore };
}
