import { Info } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Toggle } from "@vellumai/design-library/components/toggle";

import { DetailCard } from "@/components/detail-card";
import { ActivationKeyOption } from "@/domains/settings/pages/activation-key-option";
import { useTranslation } from "@/i18n";
import {
  isConfigurablePushToTalkActive,
  subscribeToConfigurablePushToTalk,
} from "@/runtime/hotkey";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import {
  CTRL_PTT_ACTIVATOR,
  LS_PTT_ACTIVATION_KEY,
  activatorDisplayName,
  activatorsEqual,
  modifierLabel,
  parseActivator,
  serializeActivator,
  sortModifiers,
  type PTTActivator,
  type PTTModifier,
} from "@/utils/ptt-activator";

const PTT_PRESETS: ReadonlyArray<{ label: string; activator: PTTActivator }> = [
  {
    label: "Ctrl",
    activator: { kind: "modifierOnly", modifiers: ["control"] },
  },
  {
    label: "Alt",
    activator: { kind: "modifierOnly", modifiers: ["option"] },
  },
  {
    label: "Ctrl+Shift",
    activator: { kind: "modifierOnly", modifiers: ["control", "shift"] },
  },
];

const labelClasses = "text-body-small-default text-[var(--content-tertiary)]";

export function PushToTalkCard() {
  const { t } = useTranslation("settings");
  const [nativeActive, setNativeActive] = useState(
    isConfigurablePushToTalkActive,
  );
  useEffect(
    () => subscribeToConfigurablePushToTalk(setNativeActive),
    [],
  );
  const [activator, setActivator] = useState<PTTActivator>(() => {
    const raw = getLocalSetting(LS_PTT_ACTIVATION_KEY, "");
    return raw
      ? parseActivator(raw)
      : { kind: "off" };
  });
  const [isRecording, setIsRecording] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<PTTModifier[]>([]);
  const recordingZoneRef = useRef<HTMLDivElement | null>(null);
  const nonModifierPressedRef = useRef(false);
  const enabled = activator.kind !== "off";
  const showFocusedTabNote = enabled && !nativeActive;

  const selectActivator = useCallback((next: PTTActivator) => {
    setActivator(next);
    setLocalSetting(LS_PTT_ACTIVATION_KEY, serializeActivator(next));
    setIsRecording(false);
    setPendingModifiers([]);
  }, []);

  const beginRecording = useCallback(() => {
    setIsRecording(true);
    setPendingModifiers([]);
    nonModifierPressedRef.current = false;
    requestAnimationFrame(() => recordingZoneRef.current?.focus());
  }, []);

  const cancelRecording = useCallback(() => {
    setIsRecording(false);
    setPendingModifiers([]);
    nonModifierPressedRef.current = false;
  }, []);

  const collectModifiers = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): PTTModifier[] => {
      const modifiers: PTTModifier[] = [];
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
      return modifiers;
    },
    [],
  );

  const handleCaptureKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        cancelRecording();
        return;
      }

      const modifiers = collectModifiers(event);
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
        setPendingModifiers(sortModifiers(modifiers));
        return;
      }

      nonModifierPressedRef.current = true;
      selectActivator({
        kind: "key",
        label: event.key.length === 1 ? event.key.toUpperCase() : event.key,
        modifiers,
      });
    },
    [cancelRecording, collectModifiers, selectActivator],
  );

  const handleCaptureKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isRecording) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
        return;
      }
      if (nonModifierPressedRef.current) {
        nonModifierPressedRef.current = false;
        setPendingModifiers([]);
        return;
      }

      if (collectModifiers(event).length === 0 && pendingModifiers.length > 0) {
        selectActivator({
          kind: "modifierOnly",
          modifiers: pendingModifiers,
        });
      }
    },
    [collectModifiers, isRecording, pendingModifiers, selectActivator],
  );

  useEffect(() => {
    if (!isRecording) {
      return;
    }
    const handler = (event: MouseEvent) => {
      if (
        recordingZoneRef.current &&
        !recordingZoneRef.current.contains(event.target as Node)
      ) {
        cancelRecording();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [cancelRecording, isRecording]);

  const isCustom =
    enabled &&
    !PTT_PRESETS.some((preset) =>
      activatorsEqual(preset.activator, activator),
    );

  return (
    <DetailCard
      title={t("voicePage.pushToTalkTitle")}
      subtitle={t("voicePage.pushToTalkSubtitle")}
    >
      <div className="flex flex-col gap-4">
        <Toggle
          checked={enabled}
          onChange={(next: boolean) => {
            selectActivator(next ? CTRL_PTT_ACTIVATOR : { kind: "off" });
          }}
          label={t("voicePage.enablePushToTalk")}
        />

        {enabled && (
          <div className="flex flex-col gap-2">
            <span className={labelClasses}>
              {t("voicePage.activationKeyLabel")}
            </span>
            <div
              ref={recordingZoneRef}
              tabIndex={isRecording ? 0 : -1}
              onKeyDown={isRecording ? handleCaptureKeyDown : undefined}
              onKeyUp={isRecording ? handleCaptureKeyUp : undefined}
              className="flex flex-wrap items-center gap-2 focus:outline-none"
            >
              {PTT_PRESETS.map((preset) => (
                <ActivationKeyOption
                  key={preset.label}
                  label={preset.label}
                  selected={activatorsEqual(preset.activator, activator)}
                  onClick={() => selectActivator(preset.activator)}
                />
              ))}
              <ActivationKeyOption
                label={
                  isRecording
                    ? pendingModifiers.length > 0
                      ? modifierLabel(pendingModifiers)
                      : t("voicePage.pressAnyKey")
                    : isCustom
                      ? activatorDisplayName(activator)
                      : t("voicePage.customKey")
                }
                selected={isRecording || isCustom}
                recording={isRecording}
                onClick={isRecording ? cancelRecording : beginRecording}
              />
            </div>

            {showFocusedTabNote && (
              <div className="flex items-start gap-1 pt-1 text-body-small-default text-[var(--content-quiet)]">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t("voicePage.pushToTalkFocusedNote")}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </DetailCard>
  );
}
