/**
 * Settings → Voice, input section: the key every voice gesture rides on.
 *
 * One key, held to dictate and double-tapped for a call. Fn out of the box, a
 * modifier set of the user's own, or nothing. The card is also where the
 * Input Monitoring grant is asked for again: the key is armed on launch and
 * asks then, so this is for the user who said no and has come back.
 *
 * Absent on hosts with no helper to watch the raw keyboard, since there is
 * nothing there to choose.
 */

import { Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import type {
  KeyboardModifier,
  SystemPermissionStatus,
} from "@vellumai/ipc-contract";

import { Button } from "@vellumai/design-library/components/button";

import { DetailCard } from "@/components/detail-card";
import { ActivationKeyOption } from "@/domains/settings/pages/activation-key-option";
import { useTranslation } from "@/i18n";
import {
  getSystemPermissionsState,
  requestSystemPermission,
} from "@/runtime/system-permissions";
import { useVoiceKeyRegistrationStore } from "@/stores/voice-key-registration-store";
import { modifierLabel, sortModifiers } from "@/utils/ptt-activator";
import {
  FN_VOICE_KEY,
  isFnVoiceKey,
  useVoiceKey,
  writeVoiceKey,
  type VoiceKey,
} from "@/utils/voice-key";

const noteClasses =
  "flex items-start gap-1 pt-1 text-body-small-lighter text-[var(--content-quiet)]";
const warningClasses =
  "flex items-start gap-1 pt-1 text-body-small-lighter text-[var(--system-negative-strong)]";

/**
 * The fewest modifiers a custom key takes. One alone is held on the way to
 * every capital letter and accented character, and a microphone that opened
 * for each of those would be a key nobody kept.
 */
const MIN_CUSTOM_MODIFIERS = 2;

function heldModifiers(
  event: ReactKeyboardEvent<HTMLElement>,
): KeyboardModifier[] {
  const modifiers: KeyboardModifier[] = [];
  if (event.ctrlKey) {
    modifiers.push("control");
  }
  if (event.altKey) {
    modifiers.push("option");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }
  if (event.metaKey) {
    modifiers.push("command");
  }
  return sortModifiers(modifiers);
}

export function VoiceKeyCard() {
  const { t } = useTranslation("settings");
  const key = useVoiceKey();
  // `false` only after the host refused the key; `null` means no attempt.
  const refused = useVoiceKeyRegistrationStore((s) => s.registered) === false;
  const [inputMonitoring, setInputMonitoring] =
    useState<SystemPermissionStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState<KeyboardModifier[]>([]);
  const [showHint, setShowHint] = useState(false);
  const zoneRef = useRef<HTMLDivElement | null>(null);

  const refreshPermission = useCallback(async () => {
    const state = await getSystemPermissionsState();
    setInputMonitoring(state?.inputMonitoring.status ?? null);
  }, []);

  useEffect(() => {
    void refreshPermission();
    // The grant is made in System Settings, which sends nothing back. Polling
    // while the card is on screen is what lets the notice go away by itself
    // once the user returns, rather than reading stale until the next reload.
    const timer = setInterval(() => {
      void refreshPermission();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [refreshPermission]);

  const askForInputMonitoring = useCallback(() => {
    void requestSystemPermission("inputMonitoring").then(refreshPermission);
  }, [refreshPermission]);

  const choose = useCallback(
    (next: VoiceKey) => {
      writeVoiceKey(next);
      setRecording(false);
      setPending([]);
      setShowHint(false);
      if (next.kind !== "off") {
        askForInputMonitoring();
      }
    },
    [askForInputMonitoring],
  );

  const beginRecording = useCallback(() => {
    setRecording(true);
    setPending([]);
    setShowHint(false);
    requestAnimationFrame(() => {
      zoneRef.current?.focus();
    });
  }, []);

  const cancelRecording = useCallback(() => {
    setRecording(false);
    setPending([]);
    setShowHint(false);
  }, []);

  const onCaptureKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        cancelRecording();
        return;
      }
      // The set builds as it is held; a key that is not a modifier is a chord,
      // which is not what this binding is.
      setPending(heldModifiers(event));
    },
    [cancelRecording],
  );

  const onCaptureKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!recording) {
        return;
      }
      // Everything let go: the set held at its fullest is the answer, if it
      // was enough of one.
      if (heldModifiers(event).length > 0) {
        return;
      }
      if (pending.length >= MIN_CUSTOM_MODIFIERS) {
        choose({ kind: "modifierOnly", modifiers: pending });
        return;
      }
      setPending([]);
      setShowHint(true);
    },
    [choose, pending, recording],
  );

  useEffect(() => {
    if (!recording) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (zoneRef.current && !zoneRef.current.contains(event.target as Node)) {
        cancelRecording();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [cancelRecording, recording]);

  const isFn = isFnVoiceKey(key);
  const isCustom = key.kind === "modifierOnly" && !isFn;
  const bound = key.kind !== "off";
  const usesControlOption =
    key.kind === "modifierOnly" &&
    key.modifiers.includes("control") &&
    key.modifiers.includes("option");
  const granted = inputMonitoring === "granted";

  return (
    <DetailCard
      title={t("voiceKeyCard.title")}
      subtitle={t("voiceKeyCard.subtitle")}
    >
      <div className="flex flex-col gap-2">
        <div
          ref={zoneRef}
          tabIndex={recording ? 0 : -1}
          onKeyDown={recording ? onCaptureKeyDown : undefined}
          onKeyUp={recording ? onCaptureKeyUp : undefined}
          className="flex flex-wrap items-center gap-2 focus:outline-none"
        >
          <ActivationKeyOption
            label={t("voiceKeyCard.fnLabel")}
            selected={isFn}
            onClick={() => choose(FN_VOICE_KEY)}
          />
          {recording ? (
            <ActivationKeyOption
              label={
                pending.length > 0
                  ? modifierLabel(pending)
                  : t("voiceKeyCard.recordingPrompt")
              }
              selected
              recording
              onClick={cancelRecording}
            />
          ) : (
            <ActivationKeyOption
              label={
                key.kind === "modifierOnly" && !isFn
                  ? modifierLabel(key.modifiers)
                  : t("voiceKeyCard.customLabel")
              }
              selected={isCustom}
              onClick={beginRecording}
            />
          )}
          <ActivationKeyOption
            label={t("voiceKeyCard.offLabel")}
            selected={!bound}
            onClick={() => choose({ kind: "off" })}
          />
        </div>

        {showHint && (
          <div className={noteClasses}>
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t("voiceKeyCard.customHint")}</span>
          </div>
        )}

        {bound && inputMonitoring !== null && !granted && (
          <div className="flex flex-col items-start gap-2 pt-1">
            <div className={warningClasses}>
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t("voiceKeyCard.needsInputMonitoring")}</span>
            </div>
            <Button variant="outlined" onClick={askForInputMonitoring}>
              {t("voiceKeyCard.allowInputMonitoring")}
            </Button>
          </div>
        )}

        {bound && granted && refused && (
          <div className={warningClasses}>
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t("voiceKeyCard.refusedNote")}</span>
          </div>
        )}

        {isFn && (
          <div className={noteClasses}>
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t("voiceKeyCard.fnDictationNote")}</span>
          </div>
        )}

        {usesControlOption && (
          <div className={noteClasses}>
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{t("voiceKeyCard.voiceOverNote")}</span>
          </div>
        )}
      </div>
    </DetailCard>
  );
}
