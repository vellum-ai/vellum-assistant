/**
 * Settings → Voice, on the voice key card: a way to find out whether a press
 * of the key reaches Vellum at all.
 *
 * The app cannot see a press that something else took first (another app's
 * event tap, a system remap of the modifier keys, a keyboard tool), so the
 * only signal is the absence of one. Pressing Test arms the wait and asks
 * for a hold; a press seen is confirmed, and one that never arrives gets a
 * note that names the known claimants running, or points at the keyboard
 * settings and tools when none are.
 */

import { Check, Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";

import { useVoiceKeyArrival } from "@/hooks/use-voice-key-arrival";
import { formatList, useTranslation } from "@/i18n";
import { runningFnClaimantNames } from "@/runtime/fn-claimants";

const noteClasses =
  "flex items-start gap-1 pt-1 text-body-small-lighter text-[var(--content-quiet)]";
const warningClasses =
  "flex items-start gap-1 pt-1 text-body-small-lighter text-[var(--system-negative-strong)]";

interface VoiceKeyTestProps {
  /** The key as the user knows it ("Fn", "Ctrl+Alt"), for the prompt and the notes. */
  keyLabel: string;
}

export function VoiceKeyTest({ keyLabel }: VoiceKeyTestProps) {
  const { t } = useTranslation("settings");
  const { phase, expectPress } = useVoiceKeyArrival();
  // The claimants running when the press never arrived. `null` until asked,
  // so the note names them from its first paint rather than growing a name.
  const [claimants, setClaimants] = useState<string[] | null>(null);

  useEffect(() => {
    if (phase !== "neverArrived") {
      return;
    }
    let stale = false;
    void runningFnClaimantNames().then((names) => {
      if (!stale) {
        setClaimants(names);
      }
    });
    return () => {
      stale = true;
    };
  }, [phase]);

  const test = useCallback(() => {
    setClaimants(null);
    expectPress();
  }, [expectPress]);

  return (
    <div className="flex flex-col items-start gap-2 pt-1">
      <Button variant="outlined" onClick={test} disabled={phase === "waiting"}>
        {t("voiceKeyTest.button")}
      </Button>

      {phase === "waiting" && (
        <div className={noteClasses}>
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t("voiceKeyTest.waiting", { key: keyLabel })}</span>
        </div>
      )}

      {phase === "arrived" && (
        <div className={noteClasses}>
          <Check className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t("voiceKeyTest.arrived", { key: keyLabel })}</span>
        </div>
      )}

      {phase === "neverArrived" && claimants !== null && (
        <div className={warningClasses}>
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {claimants.length > 0
              ? t("voiceKeyTest.neverArrivedClaimed", {
                  key: keyLabel,
                  apps: formatList(claimants),
                })
              : t("voiceKeyTest.neverArrived", { key: keyLabel })}
          </span>
        </div>
      )}
    </div>
  );
}
