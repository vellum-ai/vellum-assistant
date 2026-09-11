import { FN_USAGE_START_DICTATION } from "@vellumai/ipc-contract";
import { useEffect, useState } from "react";

import { formatList, useTranslation } from "@/i18n";
import { runningFnClaimantNames } from "@/runtime/fn-claimants";
import {
  openKeyboardSettings,
  readFnKeyState,
  type FnKeyState,
} from "@/runtime/hotkey";
import { isFnVoiceKey, useVoiceKey } from "@/utils/voice-key";

/**
 * What the introduction says when the voice key was asked for and never came.
 *
 * The one thing known for certain at this point is that no edge reached the
 * app. Two reads narrow it: the macOS keyboard settings that decide what the
 * Globe key does before any app hears it, and which of the apps known to take
 * the key are running. In that order, since a Globe key sent to No Action is
 * dropped by the driver whatever else is running. A `fnUsageType` of Start
 * Dictation does not stop a hold, so it is only mentioned, after the
 * claimants and before the generic reading that names every cause at once.
 *
 * The sentences are the settings card's where they are the same sentence, so
 * the two surfaces cannot describe one setting two ways. The Keyboard pane is
 * offered whatever the reading, since that is where the remap lives and the
 * one place the app cannot send the user by asking for a permission.
 *
 * The body waits for both reads rather than growing from the generic reading
 * into a specific one under the user's eyes; they are one round trip each.
 */
interface HoldHelpReading {
  fnState: FnKeyState | null;
  claimants: string[];
}

export function CompanionIntroHoldHelp() {
  const { t } = useTranslation();
  // The settings card's sentences, read from its catalog rather than copied.
  const { t: tSettings } = useTranslation("settings");
  const isFn = isFnVoiceKey(useVoiceKey());
  const [reading, setReading] = useState<HoldHelpReading | null>(null);

  useEffect(() => {
    let stale = false;
    void Promise.all([readFnKeyState(), runningFnClaimantNames()]).then(
      ([fnState, claimants]) => {
        if (!stale) {
          setReading({ fnState, claimants });
        }
      },
    );
    return () => {
      stale = true;
    };
  }, []);

  const body = (): string | null => {
    if (reading === null) {
      return null;
    }
    const { fnState, claimants } = reading;
    if (isFn && fnState?.fnRemappedToNoAction === true) {
      return tSettings("voiceKeyCard.fnNoActionNote");
    }
    if (claimants.length > 0) {
      return t("companionIntro.hold.claimedBody", {
        apps: formatList(claimants),
      });
    }
    if (isFn && fnState?.fnUsageType === FN_USAGE_START_DICTATION) {
      return tSettings("voiceKeyCard.fnDictationNote");
    }
    return t("companionIntro.hold.unreachedBody");
  };

  return (
    <>
      <p className="text-[12px] leading-[1.45] text-white/70">{body()}</p>
      <button
        type="button"
        className="h-7 self-start rounded-full bg-white/10 px-2.5 text-[12px] text-white/80 transition-colors hover:bg-white/20 hover:text-white"
        onClick={() => {
          void openKeyboardSettings();
        }}
      >
        {tSettings("voiceKeyCard.openKeyboardSettings")}
      </button>
    </>
  );
}
